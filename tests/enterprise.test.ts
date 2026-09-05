/**
 * Stage 20 (ADR-0035) against PostgreSQL: staff create verified
 * organisations, set tenant policy (domains, session ceiling, require SSO)
 * and suspend; platform roles and session revocation are audited; feature
 * flags are declared, evaluated and audited; the audit export is itself an
 * audit row; impersonation is a row with a reason, read-only and time-boxed;
 * an OIDC sign-in runs end to end against a LOCAL fake issuer (discovery,
 * PKCE, code exchange, ID-token verification, JIT provisioning with consent
 * and membership) and every refusal is audited; SCIM tokens are digests
 * scoped to one organisation and provisioning honours the domain policy.
 */
import './helpers/database-env';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { SignJWT, decodeJwt, exportJWK, generateKeyPair } from 'jose';

const CONNECTION_STRING = process.env.TENANCY_TEST_DATABASE_URL;
const REQUIRED = process.env.CI === 'true' || process.env.RLS_TEST_REQUIRED === '1';
if (!CONNECTION_STRING && REQUIRED) throw new Error('TENANCY_TEST_DATABASE_URL is required here (see ci.yml).');
const SKIP = CONNECTION_STRING ? false : 'TENANCY_TEST_DATABASE_URL is not set. REQUIRED in CI.';

type Db = typeof import('../src/lib/db')['db'];
type Orgs = typeof import('../src/lib/admin/organizations');
type Users = typeof import('../src/lib/admin/users');
type Flags = typeof import('../src/lib/admin/feature-flags');
type Imp = typeof import('../src/lib/admin/impersonation');
type Audit = typeof import('../src/lib/admin/audit');
type Sso = typeof import('../src/lib/sso/service');
type Scim = typeof import('../src/lib/scim/service');
type Tenancy = typeof import('../src/lib/tenancy/organizations');
type Auth = typeof import('../src/lib/auth');
type Devices = typeof import('../src/lib/integrations/device-sessions');

const S = randomBytes(4).toString('hex');
const DOMAIN = `acme-${S}.test`;
const mk = (tag: string, name: string, domain = 'enterprise.test') => ({ id: `en_${tag}_${S}`, email: `en-${tag}-${S}@${domain}`, fullName: name });
const STAFF = { ...mk('staff', 'Staff Admin'), role: 'admin' as const, storedRole: 'admin' };
const OWNER = mk('owner', 'Org Owner', DOMAIN);
const MEMBER = mk('member', 'Org Member', DOMAIN);
const OUTSIDER = mk('out', 'Outsider');
const REMOVED = mk('removed', 'Removed Person', DOMAIN);
const ALL = [STAFF, OWNER, MEMBER, OUTSIDER, REMOVED];

let db: Db;
let orgs: Orgs;
let users: Users;
let flags: Flags;
let imp: Imp;
let audit: Audit;
let sso: Sso;
let scim: Scim;
let tenancy: Tenancy;
let auth: Auth;
let devices: Devices;
let orgId = '';
let orgBId = '';
let staffSessionId = '';
let issuer = '';
let server: http.Server;
let signKey: CryptoKey;
let jwk: Record<string, unknown>;
const provisionedIds: string[] = [];
/** What the fake token endpoint answers with next: claims for the ID token. */
let nextIdToken: Record<string, unknown> = {};
let lastTokenRequest: URLSearchParams | null = null;

describe('enterprise controls - organisations, policy, roles, flags, audit export, impersonation, SSO, SCIM', { skip: SKIP }, () => {
  before(async () => {
    process.env.DATABASE_URL = CONNECTION_STRING;
    process.env.SSO_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    ({ db } = await import('../src/lib/db'));
    orgs = await import('../src/lib/admin/organizations');
    users = await import('../src/lib/admin/users');
    flags = await import('../src/lib/admin/feature-flags');
    imp = await import('../src/lib/admin/impersonation');
    audit = await import('../src/lib/admin/audit');
    sso = await import('../src/lib/sso/service');
    scim = await import('../src/lib/scim/service');
    tenancy = await import('../src/lib/tenancy/organizations');
    auth = await import('../src/lib/auth');
    devices = await import('../src/lib/integrations/device-sessions');
    for (const u of ALL) {
      await db.user.create({ data: { id: u.id, email: u.email, passwordHash: 'x', fullName: u.fullName, country: 'CA', onboardedAt: new Date(), role: u === STAFF ? 'admin' : 'member' } });
      await tenancy.ensurePersonalWorkspace(db, u);
    }
    staffSessionId = (await db.session.create({ data: { userId: STAFF.id, expiresAt: new Date(Date.now() + 3_600_000) }, select: { id: true } })).id;
    // A fake OpenID provider on the loopback: discovery, JWKS, token.
    const pair = await generateKeyPair('RS256');
    signKey = pair.privateKey as CryptoKey;
    jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    server = http.createServer(async (req, res) => {
      const json = (body: unknown, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/.well-known/openid-configuration') return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, code_challenge_methods_supported: ['S256'] });
      if (req.url === '/jwks') return json({ keys: [jwk] });
      if (req.url === '/token' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        lastTokenRequest = new URLSearchParams(body);
        if (lastTokenRequest.get('client_secret') !== 's3cret-value') return json({ error: 'invalid_client' }, 401);
        const idToken = await new SignJWT({ email_verified: true, ...nextIdToken }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(issuer).setAudience('jobpilot-client').setSubject(String(nextIdToken.sub ?? 'sub-1')).setIssuedAt().setExpirationTime('5m').sign(signKey);
        return json({ id_token: idToken, access_token: 'at', token_type: 'Bearer' });
      }
      json({ error: 'not found' }, 404);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const ids = [...ALL.map((u) => u.id), ...provisionedIds];
    await db.impersonationSession.deleteMany({ where: { staffId: STAFF.id } });
    await db.featureFlag.deleteMany({ where: { key: { in: Object.keys(flags.FLAG_REGISTRY) } } });
    await db.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { entityId: { in: [...ids, orgId, orgBId] } }, { after: { contains: orgId } }] } });
    await db.organization.deleteMany({ where: { id: { in: [orgId, orgBId].filter(Boolean) } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  });

  const status = (p: Promise<unknown>, code: number, re?: RegExp) => assert.rejects(p, (e: unknown) => e instanceof Error && (e as { status?: number }).status === code && (!re || re.test(e.message)));
  const auditCount = (action: string, entityId?: string) => db.auditLog.count({ where: { action, ...(entityId ? { entityId } : {}) } });

  it('staff create a VERIFIED organisation for an existing owner (audited with the reason); a non-verified type and an unknown owner are refused', async () => {
    await status(orgs.createVerifiedOrganization(STAFF, { name: 'x', type: 'career_consultancy' as never, ownerEmail: OWNER.email }, 'r'), 422);
    await status(orgs.createVerifiedOrganization(STAFF, { name: 'x', type: 'employer', ownerEmail: `nobody-${S}@x.test` }, 'r'), 404);
    await status(orgs.createVerifiedOrganization(STAFF, { name: 'x', type: 'employer', ownerEmail: OWNER.email }, '  '), 422, /reason/);
    const org = await orgs.createVerifiedOrganization(STAFF, { name: `Acme ${S}`, type: 'employer', ownerEmail: OWNER.email }, 'Business registration checked (test)');
    orgId = org.id;
    assert.ok(org.verifiedAt && org.verifiedByEmail === STAFF.email);
    const row = await db.auditLog.findFirstOrThrow({ where: { action: 'organization.verified', entityId: orgId } });
    assert.equal(row.reason, 'Business registration checked (test)');
    assert.equal(row.actorEmail, STAFF.email);
    orgBId = (await orgs.createVerifiedOrganization(STAFF, { name: `Other ${S}`, type: 'staffing_agency', ownerEmail: OUTSIDER.email }, 'test')).id;
    const listed = await orgs.listOrganizations({ q: `Acme ${S}` });
    assert.deepEqual(listed.map((o) => o.id), [orgId]);
    assert.equal(listed[0]!.members, 1);
  });

  it('tenant policy: invalid domains and requiring SSO without a connection are refused; the allowed-domain policy bounds invitations; the session ceiling is the shortest an account\'s organisations set', async () => {
    await status(orgs.setTenantPolicy(STAFF, orgId, { requireSso: false, allowedEmailDomains: ['not a domain'], sessionMaxHours: null }, 'r'), 422);
    await status(orgs.setTenantPolicy(STAFF, orgId, { requireSso: true, allowedEmailDomains: [], sessionMaxHours: null }, 'r'), 422, /Enable an SSO connection/);
    await status(orgs.setTenantPolicy(STAFF, orgId, { requireSso: false, allowedEmailDomains: [], sessionMaxHours: 0 }, 'r'), 422);
    await orgs.setTenantPolicy(STAFF, orgId, { requireSso: false, allowedEmailDomains: [DOMAIN.toUpperCase()], sessionMaxHours: 8 }, 'contract clause 4 (test)');
    const detail = await orgs.organizationDetail(orgId);
    assert.deepEqual(detail?.policy, { requireSso: false, allowedEmailDomains: [DOMAIN], sessionMaxHours: 8 });
    assert.equal(await auditCount('organization.policy.set', orgId), 1);
    await assert.rejects(tenancy.inviteMember(OWNER.id, orgId, { userId: OUTSIDER.id, role: 'member' }), (e: unknown) => e instanceof tenancy.OrganizationAccessError && /outside the email domains/.test(e.message));
    await tenancy.inviteMember(OWNER.id, orgId, { userId: MEMBER.id, role: 'member' });
    assert.equal(await sso.sessionMaxHoursFor(MEMBER.id), null, 'an invitation is not a membership');
    await tenancy.acceptInvitation(MEMBER.id, orgId);
    assert.equal(await sso.sessionMaxHoursFor(MEMBER.id), 8);
    assert.equal(await sso.sessionMaxHoursFor(OUTSIDER.id), null);
    assert.equal(auth.sessionTtlSeconds(await sso.sessionMaxHoursFor(MEMBER.id)), 8 * 3600);
  });

  it('platform roles and sessions: assignment is audited with before/after; nobody changes their own; an erased account is not promotable; staff sign a person out everywhere', async () => {
    await status(users.setPlatformRole(STAFF, STAFF.id, 'member', 'r'), 403);
    await status(users.setPlatformRole(STAFF, MEMBER.id, 'root' as never, 'r'), 422);
    const changed = await users.setPlatformRole(STAFF, MEMBER.id, 'support', 'joining the support rota (test)');
    assert.equal(changed.role, 'support');
    const row = await db.auditLog.findFirstOrThrow({ where: { action: 'staff.role.set', entityId: MEMBER.id } });
    assert.equal(JSON.parse(row.after).from, 'member');
    assert.equal(JSON.parse(row.after).to, 'support');
    await users.setPlatformRole(STAFF, MEMBER.id, 'member', 'rota ended (test)');
    const s1 = await db.session.create({ data: { userId: MEMBER.id, expiresAt: new Date(Date.now() + 3_600_000) } });
    const looked = await users.findUserByEmail(MEMBER.email.toUpperCase());
    assert.equal(looked?.sessions.length, 1);
    assert.equal(await users.revokeUserSessions(STAFF, MEMBER.id, 'reported phone loss (test)'), 1);
    assert.equal((await db.session.findUniqueOrThrow({ where: { id: s1.id } })).revokedReason, 'staff_revoke');
    assert.equal(await auditCount('auth.sessions.revoked_all', MEMBER.id), 1);
  });

  it('feature flags: only a declared key; evaluated deterministically with an allow-list; every change audited with before/after', async () => {
    await status(flags.setFeatureFlag(STAFF, 'dashboard.new_thing', { enabled: true, rolloutPercent: 100, allowlist: [] }, 'r'), 422, /declared in code/);
    await status(flags.setFeatureFlag(STAFF, 'console.report_export', { enabled: true, rolloutPercent: 101, allowlist: [] }, 'r'), 422);
    assert.equal(await flags.isFlagEnabled('console.report_export', STAFF.id), true, 'the declared default applies without a row');
    await flags.setFeatureFlag(STAFF, 'console.report_export', { enabled: false, rolloutPercent: 100, allowlist: [] }, 'pausing exports (test)');
    assert.equal(await flags.isFlagEnabled('console.report_export', STAFF.id), false);
    await flags.setFeatureFlag(STAFF, 'console.report_export', { enabled: true, rolloutPercent: 0, allowlist: [STAFF.id] }, 'staff only (test)');
    assert.equal(await flags.isFlagEnabled('console.report_export', STAFF.id), true);
    assert.equal(await flags.isFlagEnabled('console.report_export', OWNER.id), false);
    const rows = await db.auditLog.findMany({ where: { action: 'feature_flag.set' }, orderBy: { createdAt: 'asc' } });
    assert.ok(rows.length >= 2);
    assert.equal(JSON.parse(rows[rows.length - 1]!.after).enabledBefore, false);
    const listed = await flags.listFeatureFlags();
    assert.deepEqual(listed.find((f) => f.key === 'console.report_export')?.stored?.allowlist, [STAFF.id]);
    await flags.setFeatureFlag(STAFF, 'console.report_export', { enabled: true, rolloutPercent: 100, allowlist: [] }, 'back on (test)');
  });

  it('the audit export is filtered, capped, carries no IP column, and is itself an audit row', async () => {
    const { csv, count } = await audit.exportAuditLog(STAFF, { action: 'feature_flag.' });
    assert.ok(count >= 3);
    const lines = csv.trim().split('\r\n');
    assert.equal(lines.length, count + 1);
    assert.ok(!/\bip\b|userAgent/.test(lines[0]!));
    assert.ok(lines.slice(1).every((l) => l.includes('feature_flag.set')));
    assert.equal(await auditCount('audit.exported'), 1);
    const paged = await audit.queryAuditLog({ action: 'feature_flag.', take: 1 });
    assert.equal(paged.rows.length, 1);
    assert.ok(paged.nextCursor);
  });

  it('impersonation: a reason of substance, never staff, never yourself, one at a time; live only inside the window with the staff session live; ended by the staff member; both ends audited', async () => {
    await status(imp.startImpersonation(STAFF, { userId: MEMBER.id, reason: 'short', staffSessionId }), 422);
    await status(imp.startImpersonation(STAFF, { userId: STAFF.id, reason: 'long enough reason', staffSessionId }), 422);
    await db.user.update({ where: { id: OUTSIDER.id }, data: { role: 'support' } });
    await status(imp.startImpersonation(STAFF, { userId: OUTSIDER.id, reason: 'long enough reason', staffSessionId }), 403, /Staff accounts/);
    await db.user.update({ where: { id: OUTSIDER.id }, data: { role: 'member' } });
    const started = await imp.startImpersonation(STAFF, { userId: MEMBER.id, reason: 'ticket 4242: cannot see their applications (test)', staffSessionId });
    assert.ok(started.endsAt.getTime() - Date.now() <= 60 * 60_000 + 1000);
    const claims = decodeJwt(started.token);
    assert.equal(claims.sub, MEMBER.id);
    assert.equal(claims.imp, started.id);
    assert.equal(claims.staff, STAFF.id);
    const row = await db.impersonationSession.findUniqueOrThrow({ where: { id: started.id } });
    assert.equal(row.readOnly, true);
    assert.equal(row.staffEmail, STAFF.email);
    const c = { impersonationId: started.id, userId: MEMBER.id, staffId: STAFF.id, staffSessionId };
    assert.equal(auth.isImpersonationLive(row, c, true), true);
    assert.equal(auth.isImpersonationLive(row, c, false), false, 'the staff session revoked ends it');
    await status(imp.startImpersonation(STAFF, { userId: MEMBER.id, reason: 'another long enough reason', staffSessionId }), 409, /End your current/);
    assert.equal(await auditCount('user.impersonation.started', started.id), 1);
    assert.equal(await imp.endImpersonation({ impersonationId: started.id, staffId: `not-${STAFF.id}`, by: 'staff' }), false, 'only its own staff member ends it');
    assert.equal(await imp.endImpersonation({ impersonationId: started.id, staffId: STAFF.id, by: 'staff' }), true);
    assert.equal(auth.isImpersonationLive(await db.impersonationSession.findUniqueOrThrow({ where: { id: started.id } }), c, true), false);
    assert.equal(await auditCount('user.impersonation.ended', started.id), 1);
    assert.equal(await db.session.count({ where: { userId: MEMBER.id, method: 'staff_impersonation' } }), 0, 'no session row is issued for the target');
  });

  it('SSO: the connection is staff-set with an encrypted secret (never returned); one enabled connection per domain; requireSso closes the password door for that domain', async () => {
    await status(sso.upsertSsoConnection(STAFF, orgId, { issuer: 'not-a-url', clientId: 'c', clientSecret: 's', emailDomain: DOMAIN, jitProvisioning: true, status: 'enabled' }, 'r'), 422);
    await status(sso.upsertSsoConnection(STAFF, orgId, { issuer, clientId: 'c', clientSecret: null, emailDomain: DOMAIN, jitProvisioning: true, status: 'enabled' }, 'r'), 422, /secret is required/);
    const conn = await sso.upsertSsoConnection(STAFF, orgId, { issuer, clientId: 'jobpilot-client', clientSecret: 's3cret-value', emailDomain: DOMAIN, jitProvisioning: true, status: 'enabled' }, 'customer onboarding (test)');
    assert.ok(!('clientSecret' in conn) && !JSON.stringify(conn).includes('s3cret'));
    const raw = await db.ssoConnection.findUniqueOrThrow({ where: { organizationId: orgId } });
    assert.notEqual(raw.clientSecretCiphertext, 's3cret-value');
    assert.ok(!raw.clientSecretCiphertext.includes('s3cret'));
    const auditRow = await db.auditLog.findFirstOrThrow({ where: { action: 'sso.connection.updated', entityId: raw.id } });
    assert.ok(!JSON.stringify(auditRow).includes('s3cret'));
    await status(sso.upsertSsoConnection(STAFF, orgBId, { issuer, clientId: 'x', clientSecret: 'y', emailDomain: DOMAIN, jitProvisioning: false, status: 'enabled' }, 'r'), 409, /already claims/);
    assert.equal(await sso.passwordSignInRefusal(MEMBER.email), null);
    await orgs.setTenantPolicy(STAFF, orgId, { requireSso: true, allowedEmailDomains: [DOMAIN], sessionMaxHours: 8 }, 'SSO mandated (test)');
    assert.match((await sso.passwordSignInRefusal(MEMBER.email)) ?? '', /requires its members to sign in through/, 'an accepted member is bound by requireSso');
    assert.equal(await sso.passwordSignInRefusal(`anyone@${DOMAIN}`), null, 'review M5: an account that merely shares the domain keeps its own door');
    assert.equal(await sso.passwordSignInRefusal(OUTSIDER.email), null);
    // review H1: a public mail domain and a staff domain are never claimable
    await status(sso.upsertSsoConnection(STAFF, orgBId, { issuer, clientId: 'x', clientSecret: 'y', emailDomain: 'gmail.com', jitProvisioning: false, status: 'disabled' }, 'r'), 422, /public mail domain/);
    const staffEmailsBefore = process.env.STAFF_EMAILS;
    process.env.STAFF_EMAILS = STAFF.email;
    try {
      await status(sso.upsertSsoConnection(STAFF, orgBId, { issuer, clientId: 'x', clientSecret: 'y', emailDomain: 'enterprise.test', jitProvisioning: false, status: 'disabled' }, 'r'), 422, /staff/);
    } finally {
      process.env.STAFF_EMAILS = staffEmailsBefore;
    }
  });

  async function signIn(email: string, over: Record<string, unknown> = {}, tamper: (state: { param: string; token: string }) => { param: string; token: string } = (s) => s) {
    const begun = await sso.beginSsoSignIn({ email, redirectUri: 'http://app.test/api/auth/sso/callback' });
    const url = new URL(begun.url);
    assert.equal(url.origin + url.pathname, `${issuer}/authorize`);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    const stateParam = url.searchParams.get('state')!;
    const nonce = decodeJwt(begun.stateToken).nonce as string;
    nextIdToken = { sub: `sub-${email}`, email, email_verified: true, name: 'Pat Provisioned', nonce, ...over };
    const t = tamper({ param: stateParam, token: begun.stateToken });
    return sso.completeSsoSignIn({ code: 'code-1', state: t.param, stateToken: t.token });
  }

  it('SSO end to end against the local issuer: discovery, PKCE, the secret redeemed, the ID token verified, the account PROVISIONED with consent and an accepted membership; a second sign-in finds it', async () => {
    const email = `pat-${S}@${DOMAIN}`;
    const result = await signIn(email);
    provisionedIds.push(result.userId);
    assert.equal(result.provisioned, true);
    assert.equal(result.organizationId, orgId);
    assert.equal(result.onboarded, false, 'a provisioned account still onboards');
    assert.ok(lastTokenRequest?.get('code_verifier') && lastTokenRequest.get('code') === 'code-1' && lastTokenRequest.get('client_id') === 'jobpilot-client');
    const user = await db.user.findUniqueOrThrow({ where: { id: result.userId } });
    assert.equal(user.email, email);
    assert.equal(user.fullName, 'Pat Provisioned');
    assert.ok(user.emailVerifiedAt);
    const m = await db.membership.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: orgId, userId: user.id } } });
    assert.ok(m.acceptedAt && m.role === 'member');
    assert.equal(await db.consentRecord.count({ where: { userId: user.id, source: 'sso', purpose: { in: ['terms_of_service', 'privacy_policy'] } } }), 2);
    assert.equal(await db.organization.count({ where: { id: tenancy.personalOrganizationId(user.id) } }), 1, 'a personal workspace too');
    assert.equal(await auditCount('auth.sso.provisioned', user.id), 1);
    assert.equal(await auditCount('auth.sso.succeeded'), 1);
    const again = await signIn(email);
    assert.equal(again.provisioned, false);
    assert.equal(again.userId, user.id);
    assert.equal(await db.consentRecord.count({ where: { userId: user.id, source: 'sso' } }), 2, 'consent is not re-recorded');
  });

  it('SSO refusals are audited against a digest: unverified email, an address outside the domain, a nonce or state that does not match, a removed member, a suspended organisation, JIT off', async () => {
    const before = await db.auditLog.count({ where: { action: 'auth.sso.failed' } });
    await status(signIn(`unv-${S}@${DOMAIN}`, { email_verified: false }), 403, /not verified/);
    await status(signIn(`out-${S}@${DOMAIN}`, { email: `out-${S}@elsewhere.test` }), 403, /outside/);
    await status(signIn(`n-${S}@${DOMAIN}`, { nonce: 'wrong' }), 401, /nonce/);
    await status(signIn(`s-${S}@${DOMAIN}`, {}, (s) => ({ ...s, param: 'forged' })), 400, /does not match/);
    await status(signIn(`s2-${S}@${DOMAIN}`, {}, (s) => ({ ...s, token: s.token.slice(0, -2) + 'xx' })), 400, /expired/);
    // review H1: an existing account that merely shares the domain is not the organisation's to sign in;
    // a staff account never signs in through a tenant's provider
    const LONER = { id: `en_loner_${S}`, email: `loner-${S}@${DOMAIN}` };
    await db.user.create({ data: { id: LONER.id, email: LONER.email, passwordHash: 'x', fullName: 'Loner', country: 'CA' } });
    provisionedIds.push(LONER.id);
    await status(signIn(LONER.email), 403, /not a member of that organisation/);
    assert.equal(await db.membership.count({ where: { organizationId: orgId, userId: LONER.id } }), 0, 'no membership was created');
    const STAFFY = { id: `en_staffy_${S}`, email: `staffy-${S}@${DOMAIN}` };
    await db.user.create({ data: { id: STAFFY.id, email: STAFFY.email, passwordHash: 'x', fullName: 'Staffy', country: 'CA', role: 'support' } });
    provisionedIds.push(STAFFY.id);
    await status(signIn(STAFFY.email), 403, /Staff accounts sign in with their own credentials/);
    // an invitation the person had not answered is accepted by signing in through the organisation's provider
    await tenancy.inviteMember(OWNER.id, orgId, { userId: LONER.id, role: 'member' });
    assert.equal((await signIn(LONER.email)).provisioned, false);
    assert.ok((await db.membership.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: orgId, userId: LONER.id } } })).acceptedAt);
    // a member the organisation removed is not reinstated by the provider
    await tenancy.inviteMember(OWNER.id, orgId, { userId: REMOVED.id, role: 'member' });
    await tenancy.acceptInvitation(REMOVED.id, orgId);
    await tenancy.removeMember(OWNER.id, orgId, REMOVED.id);
    await status(signIn(REMOVED.email), 403, /removed your membership/);
    const failed = await db.auditLog.findMany({ where: { action: 'auth.sso.failed' }, orderBy: { createdAt: 'asc' } });
    assert.ok(failed.length - before >= 4);
    assert.ok(failed.every((r) => !JSON.stringify(r).includes(`@${DOMAIN}`) && JSON.parse(r.after).emailDigest), 'digests, never addresses');
    await orgs.setOrganizationStatus(STAFF, orgId, 'suspended', 'non-payment (test)');
    const failedBefore = await db.auditLog.count({ where: { action: 'auth.sso.failed' } });
    await status(sso.beginSsoSignIn({ email: `x-${S}@${DOMAIN}`, redirectUri: 'http://app.test/cb' }), 403, /suspended/);
    assert.equal(await db.auditLog.count({ where: { action: 'auth.sso.failed' } }), failedBefore + 1, 'a start-side refusal is audited too (review L8)');
    // review M3: suspension is inherited by every membership check, not only requireTenant
    assert.equal(await tenancy.findActiveMembership(db, orgId, MEMBER.id), null);
    await assert.rejects(tenancy.inviteMember(OWNER.id, orgId, { userId: OUTSIDER.id, role: 'member' }), (e: unknown) => e instanceof tenancy.OrganizationAccessError && e.status === 404);
    await orgs.setOrganizationStatus(STAFF, orgId, 'active', 'paid (test)');
    assert.ok(await tenancy.findActiveMembership(db, orgId, MEMBER.id));
    // review L11: a domain policy set after an invitation still binds its acceptance
    const LATE = { id: `en_late_${S}`, email: `late-${S}@elsewhere.test` };
    await db.user.create({ data: { id: LATE.id, email: LATE.email, passwordHash: 'x', fullName: 'Late', country: 'CA' } });
    provisionedIds.push(LATE.id);
    await orgs.setTenantPolicy(STAFF, orgId, { requireSso: true, allowedEmailDomains: [], sessionMaxHours: 8 }, 'open domains (test)');
    await tenancy.inviteMember(OWNER.id, orgId, { userId: LATE.id, role: 'member' });
    await orgs.setTenantPolicy(STAFF, orgId, { requireSso: true, allowedEmailDomains: [DOMAIN], sessionMaxHours: 8 }, 'closed again (test)');
    await assert.rejects(tenancy.acceptInvitation(LATE.id, orgId), /outside the email domains/);
    assert.equal(await auditCount('organization.suspended', orgId), 1);
    assert.equal(await auditCount('organization.reactivated', orgId), 1);
    await sso.upsertSsoConnection(STAFF, orgId, { issuer, clientId: 'jobpilot-client', emailDomain: DOMAIN, jitProvisioning: false, status: 'enabled' }, 'JIT off (test)');
    await status(signIn(`nojit-${S}@${DOMAIN}`), 403, /does not provision/);
    await sso.upsertSsoConnection(STAFF, orgId, { issuer, clientId: 'jobpilot-client', emailDomain: DOMAIN, jitProvisioning: true, status: 'enabled' }, 'JIT on (test)');
    assert.equal((await db.ssoConnection.findUniqueOrThrow({ where: { organizationId: orgId } })).clientSecretCiphertext !== '', true, 'an update without a secret keeps the stored one');
  });

  it('review H2: the mobile device sign-in honours requireSso and the session ceiling; staff revocation includes device keys', async () => {
    const PHONE = { id: `en_phone_${S}`, email: `phone-${S}@${DOMAIN}` };
    await db.user.create({ data: { id: PHONE.id, email: PHONE.email, passwordHash: await auth.hashPassword('correct horse battery staple'), fullName: 'Phone Person', country: 'CA', onboardedAt: new Date() } });
    provisionedIds.push(PHONE.id);
    await tenancy.ensurePersonalWorkspace(db, { ...PHONE, fullName: 'Phone Person' });
    const device = { name: 'Test phone', platform: 'ios' as const };
    const meta = { ip: '127.0.0.1', userAgent: 'test' };
    // not a member yet: the door is open, and the key lives the platform default
    const first = await devices.issueDeviceSession({ method: 'password', email: PHONE.email, password: 'correct horse battery staple' }, device, meta);
    assert.ok(new Date(first.session.expiresAt!).getTime() - Date.now() > 8 * 3600_000 + 60_000, 'no ceiling applies to a non-member');
    await tenancy.inviteMember(OWNER.id, orgId, { userId: PHONE.id, role: 'member' });
    await tenancy.acceptInvitation(PHONE.id, orgId);
    // a member of an organisation that requires SSO: refused after the credential, as the web doors are
    await assert.rejects(devices.issueDeviceSession({ method: 'password', email: PHONE.email, password: 'correct horse battery staple' }, device, meta), (e: unknown) => e instanceof Error && (e as { status?: number }).status === 403 && /single sign-on/.test(e.message));
    await assert.rejects(devices.issueDeviceSession({ method: 'password', email: PHONE.email, password: 'wrong' }, device, meta), (e: unknown) => e instanceof Error && (e as { status?: number }).status === 401, 'the wrong password is still 401: the refusal reveals nothing');
    await orgs.setTenantPolicy(STAFF, orgId, { requireSso: false, allowedEmailDomains: [DOMAIN], sessionMaxHours: 8 }, 'SSO optional (test)');
    const capped = await devices.issueDeviceSession({ method: 'password', email: PHONE.email, password: 'correct horse battery staple' }, device, meta);
    assert.ok(new Date(capped.session.expiresAt!).getTime() - Date.now() <= 8 * 3600_000 + 1000, 'the organisation\'s ceiling caps the device key');
    const revoked = await users.revokeUserSessions(STAFF, PHONE.id, 'lost phone (test)');
    assert.ok(revoked >= 2, 'web sessions and device keys');
    assert.equal(await db.apiKey.count({ where: { userId: PHONE.id, kind: 'device', revokedAt: null } }), 0);
    await orgs.setTenantPolicy(STAFF, orgId, { requireSso: true, allowedEmailDomains: [DOMAIN], sessionMaxHours: 8 }, 'SSO mandated again (test)');
  });

  it('review M2: an allow-listed account is never impersonated, whatever its stored role', async () => {
    const before = process.env.STAFF_EMAILS;
    process.env.STAFF_EMAILS = `${STAFF.email}, ${OUTSIDER.email}`;
    try {
      await status(imp.startImpersonation(STAFF, { userId: OUTSIDER.id, reason: 'long enough reason (test)', staffSessionId }), 403, /Staff accounts/);
    } finally {
      process.env.STAFF_EMAILS = before;
    }
  });

  it('SCIM: a token is a digest scoped to one organisation; provisioning honours the domain policy; deactivation removes the membership and revokes sessions but keeps the account; another organisation\'s token sees nothing', async () => {
    const issued = await scim.issueScimToken(STAFF, orgId, 'IdP onboarding (test)');
    assert.match(issued.token, /^scim_[0-9a-f]{8}_/);
    const tokenRow = await db.scimToken.findUniqueOrThrow({ where: { id: issued.id } });
    assert.equal(tokenRow.tokenHash, scim.hashScimToken(issued.token));
    assert.ok(!JSON.stringify(await db.auditLog.findFirstOrThrow({ where: { action: 'scim.token.issued', entityId: issued.id } })).includes(issued.token));
    await status(scim.authenticateScim(null), 401);
    await status(scim.authenticateScim('Bearer nope'), 401);
    const p = await scim.authenticateScim(`Bearer ${issued.token}`);
    assert.equal(p.organizationId, orgId);
    const base = 'http://app.test/api/scim/v2';
    const list = await scim.listScimUsers(p, { filter: null, startIndex: 1, count: 50 }, base);
    assert.ok(list.totalResults >= 3 && list.Resources.some((u) => u.userName === OWNER.email));
    assert.equal((await scim.listScimUsers(p, { filter: `userName eq "${OWNER.email.toUpperCase()}"`, startIndex: 1, count: 50 }, base)).totalResults, 1);
    await status(scim.createScimUser(p, { userName: `x-${S}@elsewhere.test` }, base), 403, /not provisioned/);
    await status(scim.createScimUser(p, { userName: 'not-an-email' }, base), 400);
    const created = await scim.createScimUser(p, { userName: `Prov-${S}@${DOMAIN}`, name: { givenName: 'Sam', familyName: 'Scim' } }, base);
    provisionedIds.push(created.id);
    assert.equal(created.userName, `prov-${S}@${DOMAIN}`);
    assert.equal(created.name.formatted, 'Sam Scim');
    assert.equal(created.active, true);
    await status(scim.createScimUser(p, { userName: `prov-${S}@${DOMAIN}` }, base), 409);
    assert.equal(await db.consentRecord.count({ where: { userId: created.id } }), 0, 'SCIM records no consent; the first sign-in does');
    const s = await db.session.create({ data: { userId: created.id, expiresAt: new Date(Date.now() + 3_600_000) } });
    const off = await scim.setScimUserActive(p, created.id, false, base);
    assert.equal(off.active, false);
    assert.ok((await db.membership.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: orgId, userId: created.id } } })).removedAt);
    assert.equal((await db.session.findUniqueOrThrow({ where: { id: s.id } })).revokedReason, 'staff_revoke');
    assert.equal(await db.user.count({ where: { id: created.id, anonymizedAt: null } }), 1, 'the account is neither deleted nor scrubbed');
    assert.equal(await auditCount('scim.user.deactivated', created.id), 1);
    assert.equal((await scim.setScimUserActive(p, created.id, true, base)).active, true);
    // review M4: an owner is never deactivated through provisioning; a removed admin comes back as a member
    await status(scim.setScimUserActive(p, OWNER.id, false, base), 403, /owner/);
    await db.membership.update({ where: { organizationId_userId: { organizationId: orgId, userId: created.id } }, data: { role: 'admin' } });
    await scim.setScimUserActive(p, created.id, false, base);
    await scim.setScimUserActive(p, created.id, true, base);
    assert.equal((await db.membership.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: orgId, userId: created.id } } })).role, 'member', 'reinstated as a member, not an admin');
    // review L5: a staff or erased account is refused with the same words as any other refusal
    const SCIMSTAFF = { id: `en_scimstaff_${S}`, email: `scimstaff-${S}@${DOMAIN}` };
    await db.user.create({ data: { id: SCIMSTAFF.id, email: SCIMSTAFF.email, passwordHash: 'x', fullName: 'Scim Staff', country: 'CA', role: 'support' } });
    provisionedIds.push(SCIMSTAFF.id);
    await status(scim.createScimUser(p, { userName: SCIMSTAFF.email }, base), 409, /cannot be provisioned/);
    await status(scim.createScimUser(p, { userName: '@corp.com' }, base), 400);
    // a token for another organisation sees none of this
    const other = await scim.issueScimToken(STAFF, orgBId, 'test');
    const pB = await scim.authenticateScim(`Bearer ${other.token}`);
    assert.equal((await scim.listScimUsers(pB, { filter: `userName eq "${OWNER.email}"`, startIndex: 1, count: 50 }, base)).totalResults, 0);
    await status(scim.getScimUser(pB, created.id, base), 404);
    await scim.revokeScimToken(STAFF, issued.id, 'rotated (test)');
    await status(scim.authenticateScim(`Bearer ${issued.token}`), 401, /revoked/);
    await orgs.setOrganizationStatus(STAFF, orgBId, 'suspended', 'test');
    await status(scim.authenticateScim(`Bearer ${other.token}`), 403, /suspended/);
  });
});
