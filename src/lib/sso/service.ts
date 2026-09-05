import { SignJWT, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { db } from '@/lib/db';
import { hashPassword, signingSecret } from '@/lib/auth';
import { REQUIRED_AT_SIGNUP, grantConsent, hasCurrentConsent } from '@/lib/consent';
import { hashEmail, recordSecurityEvent, type RequestMeta } from '@/lib/security-audit';
import { ensurePersonalWorkspace } from '@/lib/tenancy/organizations';
import { isAllowlistedStaffEmail, parseStaffAllowlist } from '@/lib/crm/allowlist';
import type { StaffContext } from '@/lib/crm/auth';
import { decryptClientSecret, encryptClientSecret } from './crypto';
import { OidcError, authorizationUrl, discover, emailDomain, exchangeCode, isEmailDomain, isIssuerUrl, pkcePair, randomToken, verifyIdToken, type OidcDiscovery } from './oidc';

/**
 * Stage 20 (ADR-0035) - enterprise sign-in: one OIDC connection per
 * organisation, authoritative for ONE email domain.
 *
 * What holds here:
 * - The client secret is encrypted at rest (crypto.ts) and decrypted only in
 *   `completeSsoSignIn`, to redeem a code; it is never returned to the console.
 * - A connection is administered by JobPilot staff under step-up and audited;
 *   an organisation's own admins cannot point their members at an issuer.
 * - The provider AUTHENTICATES; the platform still AUTHORISES: the session
 *   issued afterwards is the same revocable row every other sign-in gets.
 * - Just-in-time provisioning creates the account and an ACCEPTED membership
 *   because the organisation's identity provider vouched for the person; a
 *   membership the organisation REMOVED is not silently reinstated - that is
 *   the organisation's decision, recorded by SCIM or by an admin.
 * - `requireSso` is enforced where the password path starts (login route),
 *   by asking `passwordSignInRefusal`.
 * No real identity provider has been called from this codebase.
 */

export class SsoError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'SsoError';
    this.status = status;
  }
}

export const SSO_STATE_TTL_SECONDS = 10 * 60;
export const SSO_STATE_COOKIE = 'jobpilot_sso_state';

/**
 * Domains no organisation may claim (Stage 20 review, H1): a public mail
 * domain is not an organisation's, and the STAFF_EMAILS domains would let a
 * single admin's connection mint sessions for every other admin.
 */
export const PUBLIC_MAIL_DOMAINS: ReadonlySet<string> = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'yahoo.ca', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net', 'zoho.com', 'mail.com', 'fastmail.com', 'hey.com', 'yandex.com', 'qq.com', '163.com']);

export function staffDomains(raw: string | null | undefined = process.env.STAFF_EMAILS): Set<string> {
  return new Set(parseStaffAllowlist(raw).map((e) => e.slice(e.lastIndexOf('@') + 1).toLowerCase()).filter(Boolean));
}

/** Why a domain may not be claimed by a connection, or null. Pure. */
export function domainClaimRefusal(domain: string, staffRaw: string | null | undefined = process.env.STAFF_EMAILS): string | null {
  if (PUBLIC_MAIL_DOMAINS.has(domain)) return 'A public mail domain cannot be an organisation\'s sign-in domain.';
  if (staffDomains(staffRaw).has(domain)) return 'That domain is JobPilot staff\'s and cannot be claimed by an organisation.';
  return null;
}

export interface SsoConnectionInput {
  issuer: string;
  clientId: string;
  /** Required on creation; omit to keep the stored secret on an update. */
  clientSecret?: string | null;
  emailDomain: string;
  jitProvisioning: boolean;
  status: 'enabled' | 'disabled';
}

/** Create or update an organisation's connection. Staff admin, step-up (the route), audited. Never returns the secret. */
export async function upsertSsoConnection(staff: StaffContext, organizationId: string, input: SsoConnectionInput, reason: string, meta?: RequestMeta) {
  if (!isIssuerUrl(input.issuer)) throw new SsoError('The issuer is an https URL without a query or fragment.', 422);
  if (!input.clientId.trim()) throw new SsoError('A client id is required.', 422);
  const domain = input.emailDomain.trim().toLowerCase();
  if (!isEmailDomain(domain)) throw new SsoError('The email domain is not a domain name.', 422);
  if (!reason.trim()) throw new SsoError('A reason is required.', 422);
  const refusal = domainClaimRefusal(domain);
  if (refusal) throw new SsoError(refusal, 422);
  const org = await db.organization.findUnique({ where: { id: organizationId }, select: { id: true, type: true } });
  if (!org || org.type === 'personal') throw new SsoError('Organisation not found.', 404);
  const existing = await db.ssoConnection.findUnique({ where: { organizationId } });
  const secret = input.clientSecret?.trim() ? encryptClientSecret(input.clientSecret.trim()) : null;
  if (!existing && !secret) throw new SsoError('A client secret is required to create a connection.', 422);
  const data = {
    issuer: input.issuer.replace(/\/$/, ''),
    clientId: input.clientId.trim(),
    emailDomain: domain,
    jitProvisioning: input.jitProvisioning,
    status: input.status,
    ...(secret ? { clientSecretCiphertext: secret.ciphertext, clientSecretIv: secret.iv, clientSecretTag: secret.tag, clientSecretKeyVersion: secret.keyVersion } : {}),
  };
  // One domain is claimed by at most one ENABLED connection: the domain is how
  // an email is routed to its issuer, and two claimants would make sign-in
  // ambiguous. Checked and written under one advisory lock keyed by the
  // domain (a partial unique index would be invisible to Prisma's drift
  // check), so two admins racing cannot both claim it (review L3).
  const row = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'sso_domain:' + domain}))`;
    if (input.status === 'enabled') {
      const claimant = await tx.ssoConnection.findFirst({ where: { emailDomain: domain, status: 'enabled', NOT: { organizationId } }, select: { organizationId: true } });
      if (claimant) throw new SsoError('Another organisation\'s enabled connection already claims that email domain.', 409);
    }
    return existing
      ? tx.ssoConnection.update({ where: { id: existing.id }, data })
      : tx.ssoConnection.create({ data: { organizationId, createdByEmail: staff.email, ...data, clientSecretCiphertext: secret!.ciphertext, clientSecretIv: secret!.iv, clientSecretTag: secret!.tag, clientSecretKeyVersion: secret!.keyVersion } });
  });
  await recordSecurityEvent(
    { event: 'sso.connection.updated', actor: { type: 'staff', id: staff.id, email: staff.email, role: staff.role }, entityType: 'SsoConnection', entityId: row.id, summary: `SSO connection ${existing ? 'updated' : 'created'} (${input.status})`, detail: { organizationId, issuer: data.issuer, clientId: data.clientId, emailDomain: domain, jitProvisioning: input.jitProvisioning, status: input.status, secretRotated: secret !== null, issuerBefore: existing?.issuer ?? null, clientIdBefore: existing?.clientId ?? null, emailDomainBefore: existing?.emailDomain ?? null, jitProvisioningBefore: existing?.jitProvisioning ?? null, statusBefore: existing?.status ?? null }, reason: reason.trim().slice(0, 500), meta },
    db,
    { strict: true },
  );
  return describeConnection(row);
}

function describeConnection(row: { id: string; organizationId: string; protocol: string; issuer: string; clientId: string; emailDomain: string; jitProvisioning: boolean; status: string; createdByEmail: string; lastSignInAt: Date | null; updatedAt: Date }) {
  return { id: row.id, organizationId: row.organizationId, protocol: row.protocol, issuer: row.issuer, clientId: row.clientId, emailDomain: row.emailDomain, jitProvisioning: row.jitProvisioning, status: row.status, createdByEmail: row.createdByEmail, lastSignInAt: row.lastSignInAt, updatedAt: row.updatedAt, hasSecret: true };
}

export async function describeSsoConnection(organizationId: string) {
  const row = await db.ssoConnection.findUnique({ where: { organizationId } });
  return row ? describeConnection(row) : null;
}

/** The enabled connection authoritative for an address's domain, with the organisation's policy, or null. */
export async function connectionForEmail(email: string) {
  const domain = emailDomain(email);
  if (!domain) return null;
  return db.ssoConnection.findFirst({ where: { emailDomain: domain, status: 'enabled' }, include: { organization: { select: { id: true, name: true, slug: true, status: true, requireSso: true, sessionMaxHours: true } } } });
}

/**
 * Why a password (or identity-provider, or device) sign-in for this address
 * is refused, or null when it is allowed. The organisation's `requireSso`
 * binds ITS MEMBERS: an accepted member of the organisation whose enabled
 * connection claims the address's domain (review M5). An account under that
 * domain that is not a member keeps its own doors - the policy is the
 * organisation's over its people, not over everyone at the domain.
 */
export async function passwordSignInRefusal(email: string): Promise<string | null> {
  const c = await connectionForEmail(email);
  if (!c || !c.organization.requireSso) return null;
  const member = await db.membership.findFirst({ where: { organizationId: c.organizationId, acceptedAt: { not: null }, removedAt: null, user: { email: email.trim().toLowerCase() } }, select: { id: true } });
  if (!member) return null;
  return `${c.organization.name} requires its members to sign in through the organisation's single sign-on. Use "Sign in with your organisation".`;
}

/** The shortest session an organisation the person belongs to allows, in hours; null means the platform default. */
export async function sessionMaxHoursFor(userId: string): Promise<number | null> {
  const rows = await db.membership.findMany({ where: { userId, acceptedAt: { not: null }, removedAt: null, organization: { sessionMaxHours: { not: null } } }, select: { organization: { select: { sessionMaxHours: true } } } });
  const hours = rows.map((r) => r.organization.sessionMaxHours).filter((h): h is number => typeof h === 'number' && h > 0);
  return hours.length ? Math.min(...hours) : null;
}

interface StateClaims {
  connectionId: string;
  organizationId: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  emailDigest: string;
}

/**
 * Start a sign-in for an address: route it to its domain's connection, run
 * discovery, mint PKCE + nonce + state, and return the authorization URL with
 * the signed state token the route stores in an httpOnly cookie. The `state`
 * query parameter is the token's id; the callback matches the two.
 */
export async function beginSsoSignIn(input: { email: string; redirectUri: string; fetchImpl?: typeof fetch; meta?: RequestMeta }): Promise<{ url: string; stateToken: string; organizationName: string }> {
  const email = input.email.trim().toLowerCase();
  const c = await connectionForEmail(email);
  if (!c) throw new SsoError('No organisation sign-in is configured for that email domain.', 404);
  if (c.organization.status === 'suspended') {
    await recordSecurityEvent({ event: 'auth.sso.failed', actor: { type: 'system' }, entityType: 'SsoConnection', entityId: c.id, summary: 'SSO sign-in refused at start', detail: { organizationId: c.organizationId, emailDigest: hashEmail(email), reason: 'organisation suspended' }, meta: input.meta });
    throw new SsoError('That organisation is suspended.', 403);
  }
  let discovery;
  try {
    discovery = await discover(c.issuer, input.fetchImpl);
  } catch (error) {
    await recordSecurityEvent({ event: 'auth.sso.failed', actor: { type: 'system' }, entityType: 'SsoConnection', entityId: c.id, summary: 'SSO sign-in refused at start (discovery)', detail: { organizationId: c.organizationId, emailDigest: hashEmail(email), reason: error instanceof Error ? error.message : 'discovery failed' }, meta: input.meta });
    throw error;
  }
  const { verifier, challenge } = pkcePair();
  const nonce = randomToken();
  const stateId = randomToken();
  const claims: StateClaims = { connectionId: c.id, organizationId: c.organizationId, nonce, codeVerifier: verifier, redirectUri: input.redirectUri, emailDigest: hashEmail(email) };
  const stateToken = await new SignJWT({ ...claims }).setProtectedHeader({ alg: 'HS256' }).setJti(stateId).setIssuedAt().setExpirationTime(`${SSO_STATE_TTL_SECONDS}s`).sign(signingSecret());
  const url = authorizationUrl(discovery, { clientId: c.clientId, redirectUri: input.redirectUri, state: stateId, nonce, codeChallenge: challenge, loginHint: email });
  return { url, stateToken, organizationName: c.organization.name };
}

export interface SsoSignInResult {
  userId: string;
  email: string;
  organizationId: string;
  provisioned: boolean;
  onboarded: boolean;
}

/**
 * Finish a sign-in: match the state, redeem the code, verify the ID token,
 * bind the address to the connection's domain, then find or provision the
 * person and their membership. Returns who signed in; the route issues the
 * session. Every refusal is audited against the address's DIGEST.
 */
export async function completeSsoSignIn(input: { code: string; state: string; stateToken: string; fetchImpl?: typeof fetch; getKey?: JWTVerifyGetKey; discovery?: OidcDiscovery; meta?: RequestMeta }): Promise<SsoSignInResult> {
  let claims: StateClaims & { jti?: string };
  try {
    const { payload } = await jwtVerify(input.stateToken, signingSecret());
    claims = payload as unknown as StateClaims & { jti?: string };
  } catch {
    throw new SsoError('This sign-in has expired. Start again.', 400);
  }
  if (!claims.jti || claims.jti !== input.state) throw new SsoError('This sign-in does not match the one that was started.', 400);
  const c = await db.ssoConnection.findUnique({ where: { id: claims.connectionId }, include: { organization: { select: { id: true, name: true, status: true, allowedEmailDomains: true } } } });
  const refuse = async (message: string, status: number, detail: Record<string, string | number | boolean | null> = {}) => {
    await recordSecurityEvent({ event: 'auth.sso.failed', actor: { type: 'system' }, entityType: 'SsoConnection', entityId: c?.id ?? claims.connectionId, summary: 'SSO sign-in refused', detail: { organizationId: c?.organizationId ?? claims.organizationId, emailDigest: claims.emailDigest, reason: message, ...detail }, meta: input.meta });
    return new SsoError(message, status);
  };
  if (!c || c.status !== 'enabled') throw await refuse('That organisation sign-in is no longer enabled.', 403);
  if (c.organization.status === 'suspended') throw await refuse('That organisation is suspended.', 403);
  const discovery = input.discovery ?? (await discover(c.issuer, input.fetchImpl));
  const clientSecret = decryptClientSecret({ ciphertext: c.clientSecretCiphertext, iv: c.clientSecretIv, tag: c.clientSecretTag, keyVersion: c.clientSecretKeyVersion });
  let identity;
  try {
    const tokens = await exchangeCode(discovery, { code: input.code, codeVerifier: claims.codeVerifier, clientId: c.clientId, clientSecret, redirectUri: claims.redirectUri }, input.fetchImpl);
    identity = await verifyIdToken(tokens.id_token, { issuer: c.issuer, clientId: c.clientId, nonce: claims.nonce, getKey: input.getKey, jwksUri: discovery.jwks_uri });
  } catch (error) {
    if (error instanceof OidcError) throw await refuse(error.message, error.status);
    throw error;
  }
  // The connection is authoritative for ONE domain. An identity provider that
  // releases an address outside it (a misconfigured tenant, a guest account)
  // does not get to sign that address in here.
  if (emailDomain(identity.email) !== c.emailDomain) throw await refuse(`The identity provider released an address outside ${c.emailDomain}.`, 403);
  const existing = await db.user.findUnique({ where: { email: identity.email }, select: { id: true, email: true, role: true, anonymizedAt: true, onboardedAt: true } });
  if (existing?.anonymizedAt) throw await refuse('That account was erased.', 403);
  // The platform AUTHORISES (review H1): an organisation's provider never
  // signs in a staff account - a console credential is the platform's, not
  // a tenant's - and an existing account is signed in only when it already
  // belongs to the organisation (an accepted membership, or an invitation the
  // person answers by signing in through the organisation's own provider).
  // An account that merely shares the domain is not the organisation's to
  // take over: it is refused until the organisation invites the person and
  // they accept from their own session.
  if (existing && (existing.role !== 'member' || isAllowlistedStaffEmail(existing.email, process.env.STAFF_EMAILS))) throw await refuse('Staff accounts sign in with their own credentials, never through an organisation\'s provider.', 403);
  let userId: string;
  let provisioned = false;
  let onboarded = existing?.onboardedAt !== null && existing?.onboardedAt !== undefined;
  if (!existing) {
    if (!c.jitProvisioning) throw await refuse('No account exists for that address and this organisation does not provision accounts at sign-in.', 403);
    // The account exists because the organisation's provider vouched for the
    // person. It has a password nobody knows (a random one, hashed) so the
    // password route cannot be used against it. It cannot set one either:
    // the password-change flow needs the current one, and no reset flow
    // exists (stated in ADR-0035) - the account signs in through SSO.
    const passwordHash = await hashPassword(randomToken(32));
    const created = await db.$transaction(async (tx) => {
      const u = await tx.user.create({ data: { email: identity.email, passwordHash, fullName: identity.name || identity.email.split('@')[0]!, country: 'CA', emailVerifiedAt: new Date() }, select: { id: true, email: true, fullName: true } });
      await ensurePersonalWorkspace(tx, u);
      for (const purpose of REQUIRED_AT_SIGNUP) await grantConsent(tx, u, purpose, { source: 'sso', meta: input.meta });
      await tx.membership.create({ data: { organizationId: c.organizationId, userId: u.id, role: 'member', invitedEmail: identity.email, acceptedAt: new Date() } });
      return u;
    });
    userId = created.id;
    provisioned = true;
    onboarded = false;
    await recordSecurityEvent({ event: 'auth.sso.provisioned', user: { id: userId, email: identity.email }, actor: { type: 'system' }, entityType: 'User', entityId: userId, summary: 'Account provisioned at first SSO sign-in', detail: { organizationId: c.organizationId, connectionId: c.id }, meta: input.meta });
  } else {
    userId = existing.id;
    const m = await db.membership.findUnique({ where: { organizationId_userId: { organizationId: c.organizationId, userId } } });
    if (m?.removedAt) throw await refuse('Your organisation removed your membership; ask your administrator to reinstate it.', 403);
    if (!m) throw await refuse('Your account is not a member of that organisation. Ask an administrator to invite you, accept the invitation from your own session, then sign in here.', 403);
    if (!m.acceptedAt) {
      // An invitation the person had not answered: signing in through the
      // organisation's own provider is the acceptance.
      await db.membership.update({ where: { id: m.id }, data: { acceptedAt: new Date() } });
    }
    // A SCIM-provisioned account has not seen the platform's wording; it is
    // shown on the organisation sign-in page and recorded at first sign-in.
    for (const purpose of REQUIRED_AT_SIGNUP) {
      if (!(await hasCurrentConsent(db, userId, purpose))) await grantConsent(db, { id: userId, email: existing.email }, purpose, { source: 'sso', meta: input.meta });
    }
  }
  db.ssoConnection.update({ where: { id: c.id }, data: { lastSignInAt: new Date() } }).catch(() => undefined);
  await recordSecurityEvent({ event: 'auth.sso.succeeded', user: { id: userId, email: identity.email }, entityType: 'SsoConnection', entityId: c.id, summary: 'Signed in through the organisation\'s SSO', detail: { organizationId: c.organizationId, provisioned }, meta: input.meta });
  return { userId, email: identity.email, organizationId: c.organizationId, provisioned, onboarded };
}
