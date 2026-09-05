import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { db } from '@/lib/db';
import { hashPassword, revokeAllSessions } from '@/lib/auth';
import type { StaffContext } from '@/lib/crm/auth';
import { hashEmail, recordSecurityEvent, type RequestMeta } from '@/lib/security-audit';
import { ensurePersonalWorkspace } from '@/lib/tenancy/organizations';
import { domainAllowed, parseDomains } from '@/lib/admin/organizations';
import { emailDomain } from '@/lib/sso/oidc';

/**
 * Stage 20 (ADR-0035) - SCIM 2.0 (RFC 7643/7644), the Users resource only,
 * so an organisation's identity provider can provision and deprovision its
 * members. What it can and cannot do:
 *
 * - A bearer token is issued by JobPilot staff for ONE organisation and is
 *   stored as a SHA-256 digest with a display prefix; the plaintext is shown
 *   once. Every call is scoped to that organisation - a SCIM client sees only
 *   the memberships of its own organisation, never other tenants and never
 *   the person's job-search data.
 * - Creating a user PROVISIONS an account (if none exists) and an ACCEPTED
 *   membership. The address must fall under the organisation's provisioning
 *   domains (its policy's allowed domains, or its SSO domain); with neither
 *   configured nothing is provisioned - fail closed.
 * - Deactivating (`active: false`, or DELETE) REMOVES the membership and
 *   revokes the person's sessions. It never deletes or scrubs the account:
 *   the person's own data is theirs, and erasure is the person's request
 *   under the privacy process, not an IdP's.
 * - No real identity provider has driven this endpoint (Okta, Entra); the
 *   register says IMPLEMENTED-NOT-VALIDATED.
 */
export class ScimError extends Error {
  readonly status: number;
  readonly scimType?: string;
  constructor(message: string, status = 400, scimType?: string) {
    super(message);
    this.name = 'ScimError';
    this.status = status;
    this.scimType = scimType;
  }
}

export const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
export const SCIM_PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

export function hashScimToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/** Issue a token for an organisation. Returned ONCE; the row keeps a digest and a prefix. */
export async function issueScimToken(staff: StaffContext, organizationId: string, reason: string, meta?: RequestMeta): Promise<{ id: string; token: string; prefix: string }> {
  if (!reason.trim()) throw new ScimError('A reason is required.', 422);
  const org = await db.organization.findUnique({ where: { id: organizationId }, select: { id: true, type: true } });
  if (!org || org.type === 'personal') throw new ScimError('Organisation not found.', 404);
  const prefix = `scim_${randomBytes(4).toString('hex')}`;
  const token = `${prefix}_${randomBytes(24).toString('base64url')}`;
  const row = await db.scimToken.create({ data: { organizationId, tokenHash: hashScimToken(token), prefix, createdByEmail: staff.email } });
  await recordSecurityEvent(
    { event: 'scim.token.issued', actor: { type: 'staff', id: staff.id, email: staff.email, role: staff.role }, entityType: 'ScimToken', entityId: row.id, summary: `SCIM token ${prefix} issued`, detail: { organizationId, prefix }, reason: reason.trim().slice(0, 500), meta },
    db,
    { strict: true },
  );
  return { id: row.id, token, prefix };
}

export async function revokeScimToken(staff: StaffContext, tokenId: string, reason: string, meta?: RequestMeta): Promise<void> {
  if (!reason.trim()) throw new ScimError('A reason is required.', 422);
  const row = await db.scimToken.findUnique({ where: { id: tokenId } });
  if (!row) throw new ScimError('Token not found.', 404);
  if (row.revokedAt) throw new ScimError('Already revoked.', 409);
  await db.scimToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
  await recordSecurityEvent(
    { event: 'scim.token.revoked', actor: { type: 'staff', id: staff.id, email: staff.email, role: staff.role }, entityType: 'ScimToken', entityId: row.id, summary: `SCIM token ${row.prefix} revoked`, detail: { organizationId: row.organizationId, prefix: row.prefix }, reason: reason.trim().slice(0, 500), meta },
    db,
    { strict: true },
  );
}

export interface ScimPrincipal {
  organizationId: string;
  tokenId: string;
  prefix: string;
}

/** Authenticate `Authorization: Bearer <token>`: digest lookup, constant-time compare, not revoked, organisation not suspended. */
export async function authenticateScim(authorization: string | null): Promise<ScimPrincipal> {
  const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
  if (!m) throw new ScimError('A bearer token is required.', 401);
  const presented = m[1]!;
  const digest = hashScimToken(presented);
  const row = await db.scimToken.findUnique({ where: { tokenHash: digest }, include: { organization: { select: { status: true } } } });
  // The lookup is by digest; the compare below is belt and braces against a
  // lookup that returned a row for any reason other than equality.
  if (!row || !timingSafeEqual(Buffer.from(row.tokenHash), Buffer.from(digest))) throw new ScimError('Invalid token.', 401);
  if (row.revokedAt) throw new ScimError('Token revoked.', 401);
  if (row.organization.status === 'suspended') throw new ScimError('Organisation suspended.', 403);
  db.scimToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  return { organizationId: row.organizationId, tokenId: row.id, prefix: row.prefix };
}

export interface ScimUser {
  schemas: string[];
  id: string;
  externalId?: string;
  userName: string;
  name: { formatted: string };
  emails: { value: string; primary: boolean }[];
  active: boolean;
  meta: { resourceType: 'User'; created: string; lastModified: string; location: string };
}

type MemberRow = { userId: string; acceptedAt: Date | null; removedAt: Date | null; createdAt: Date; updatedAt: Date; user: { email: string; fullName: string; anonymizedAt: Date | null; createdAt: Date } };

export function toScimUser(m: MemberRow, baseUrl: string): ScimUser {
  const erased = m.user.anonymizedAt !== null;
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: m.userId,
    userName: erased ? `erased-${m.userId}` : m.user.email,
    name: { formatted: erased ? '' : m.user.fullName },
    emails: erased ? [] : [{ value: m.user.email, primary: true }],
    active: m.removedAt === null && !erased,
    meta: { resourceType: 'User', created: m.createdAt.toISOString(), lastModified: m.updatedAt.toISOString(), location: `${baseUrl}/Users/${m.userId}` },
  };
}

/** The only filter an IdP sends before creating: `userName eq "address"`. Anything else is refused as unsupported (RFC 7644 §3.4.2.2). */
export function parseUserNameFilter(filter: string | null): string | null {
  if (!filter) return null;
  const m = /^\s*userName\s+eq\s+"([^"]+)"\s*$/i.exec(filter);
  if (!m) throw new ScimError('Only the filter userName eq "value" is supported.', 400, 'invalidFilter');
  return m[1]!.trim().toLowerCase();
}

const memberInclude = { user: { select: { email: true, fullName: true, anonymizedAt: true, createdAt: true } } } as const;

export async function listScimUsers(p: ScimPrincipal, q: { filter: string | null; startIndex: number; count: number }, baseUrl: string) {
  const userName = parseUserNameFilter(q.filter);
  const where = { organizationId: p.organizationId, ...(userName ? { user: { email: userName } } : {}) };
  const startIndex = Math.max(q.startIndex, 1);
  const count = Math.min(Math.max(q.count, 0), 200);
  const [total, rows] = await Promise.all([db.membership.count({ where }), db.membership.findMany({ where, include: memberInclude, orderBy: { createdAt: 'asc' }, skip: startIndex - 1, take: count })]);
  return { schemas: [SCIM_LIST_SCHEMA], totalResults: total, startIndex, itemsPerPage: rows.length, Resources: rows.map((r) => toScimUser(r, baseUrl)) };
}

export async function getScimUser(p: ScimPrincipal, userId: string, baseUrl: string): Promise<ScimUser> {
  const m = await db.membership.findUnique({ where: { organizationId_userId: { organizationId: p.organizationId, userId } }, include: memberInclude });
  if (!m) throw new ScimError('User not found.', 404);
  return toScimUser(m, baseUrl);
}

async function provisioningDomains(organizationId: string): Promise<string[]> {
  const org = await db.organization.findUnique({ where: { id: organizationId }, select: { allowedEmailDomains: true, ssoConnection: { select: { emailDomain: true, status: true } } } });
  const domains = parseDomains(org?.allowedEmailDomains ?? '[]');
  if (org?.ssoConnection?.status === 'enabled') domains.push(org.ssoConnection.emailDomain);
  return [...new Set(domains)];
}

/** POST /Users: provision (or attach) the account and an accepted membership. */
export async function createScimUser(p: ScimPrincipal, body: { userName?: unknown; name?: unknown; active?: unknown; emails?: unknown }, baseUrl: string, meta?: RequestMeta): Promise<ScimUser> {
  const userName = typeof body.userName === 'string' ? body.userName.trim().toLowerCase() : '';
  if (!userName || !userName.includes('@')) throw new ScimError('userName is the person\'s email address.', 400, 'invalidValue');
  const domains = await provisioningDomains(p.organizationId);
  if (domains.length === 0) throw new ScimError('This organisation has no provisioning domain configured; JobPilot staff set one under its policy or SSO connection.', 403);
  if (!domainAllowed(domains, userName)) throw new ScimError(`Addresses under ${emailDomain(userName) || '(none)'} are not provisioned for this organisation.`, 403);
  const name = body.name && typeof body.name === 'object' ? (body.name as Record<string, unknown>) : {};
  const formatted = typeof name.formatted === 'string' && name.formatted.trim() ? name.formatted.trim() : [name.givenName, name.familyName].filter((s) => typeof s === 'string' && s).join(' ').trim() || userName.split('@')[0]!;
  const active = body.active !== false;
  const existing = await db.user.findUnique({ where: { email: userName }, select: { id: true, anonymizedAt: true } });
  if (existing?.anonymizedAt) throw new ScimError('That address belongs to an erased account.', 409, 'uniqueness');
  const current = existing ? await db.membership.findUnique({ where: { organizationId_userId: { organizationId: p.organizationId, userId: existing.id } } }) : null;
  if (current && current.removedAt === null && current.acceptedAt !== null) throw new ScimError('That user is already a member.', 409, 'uniqueness');
  const userId = await db.$transaction(async (tx) => {
    let id = existing?.id;
    if (!id) {
      const created = await tx.user.create({ data: { email: userName, passwordHash: await hashPassword(randomBytes(32).toString('base64url')), fullName: formatted.slice(0, 120), country: 'CA', emailVerifiedAt: new Date() }, select: { id: true, email: true, fullName: true } });
      await ensurePersonalWorkspace(tx, created);
      id = created.id;
    }
    await tx.membership.upsert({
      where: { organizationId_userId: { organizationId: p.organizationId, userId: id } },
      create: { organizationId: p.organizationId, userId: id, role: 'member', invitedEmail: userName, acceptedAt: active ? new Date() : null, removedAt: active ? null : new Date() },
      update: { acceptedAt: active ? new Date() : null, removedAt: active ? null : new Date() },
    });
    return id;
  });
  await recordSecurityEvent({ event: 'scim.user.provisioned', user: { id: userId, email: userName }, actor: { type: 'api_key', id: p.tokenId, email: '', role: 'scim' }, entityType: 'Membership', entityId: userId, summary: `SCIM provisioned a ${existing ? 'membership' : 'user and membership'}`, detail: { organizationId: p.organizationId, tokenPrefix: p.prefix, created: !existing, active, emailDigest: hashEmail(userName) }, meta });
  return getScimUser(p, userId, baseUrl);
}

/** PATCH /Users/:id with `replace` operations on `active` and `name.formatted`; PUT semantics for the same two fields. */
export async function setScimUserActive(p: ScimPrincipal, userId: string, active: boolean, baseUrl: string, meta?: RequestMeta): Promise<ScimUser> {
  const m = await db.membership.findUnique({ where: { organizationId_userId: { organizationId: p.organizationId, userId } }, include: memberInclude });
  if (!m) throw new ScimError('User not found.', 404);
  const isActive = m.removedAt === null;
  if (isActive !== active) {
    await db.membership.update({ where: { id: m.id }, data: active ? { removedAt: null, acceptedAt: m.acceptedAt ?? new Date() } : { removedAt: new Date() } });
    let revoked = 0;
    if (!active) revoked = await revokeAllSessions(userId, 'staff_revoke');
    await recordSecurityEvent({ event: active ? 'scim.user.reactivated' : 'scim.user.deactivated', user: { id: userId, email: m.user.email }, actor: { type: 'api_key', id: p.tokenId, email: '', role: 'scim' }, entityType: 'Membership', entityId: userId, summary: active ? 'SCIM reactivated a membership' : `SCIM deactivated a membership (${revoked} session(s) revoked)`, detail: { organizationId: p.organizationId, tokenPrefix: p.prefix, sessionsRevoked: revoked }, meta });
  }
  return getScimUser(p, userId, baseUrl);
}

export async function renameScimUser(p: ScimPrincipal, userId: string, formatted: string): Promise<void> {
  const m = await db.membership.findUnique({ where: { organizationId_userId: { organizationId: p.organizationId, userId } }, select: { id: true, user: { select: { anonymizedAt: true } } } });
  if (!m) throw new ScimError('User not found.', 404);
  if (m.user.anonymizedAt) return;
  const name = formatted.trim().slice(0, 120);
  if (name) await db.user.update({ where: { id: userId }, data: { fullName: name } });
}

/** The PatchOp body → the two things this endpoint honours. Anything else is refused, not ignored. */
export function parsePatch(body: { schemas?: unknown; Operations?: unknown }): { active?: boolean; formatted?: string } {
  if (!Array.isArray(body.schemas) || !body.schemas.includes(SCIM_PATCH_SCHEMA)) throw new ScimError('A PatchOp body is required.', 400, 'invalidSyntax');
  if (!Array.isArray(body.Operations) || body.Operations.length === 0) throw new ScimError('Operations is required.', 400, 'invalidSyntax');
  const out: { active?: boolean; formatted?: string } = {};
  for (const raw of body.Operations as unknown[]) {
    const op = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const kind = String(op.op ?? '').toLowerCase();
    if (kind !== 'replace' && kind !== 'add') throw new ScimError(`Operation ${kind || '(none)'} is not supported.`, 400, 'invalidValue');
    const path = typeof op.path === 'string' ? op.path : '';
    if (path === 'active') {
      if (typeof op.value !== 'boolean' && op.value !== 'true' && op.value !== 'false' && op.value !== 'True' && op.value !== 'False') throw new ScimError('active is a boolean.', 400, 'invalidValue');
      out.active = op.value === true || op.value === 'true' || op.value === 'True';
    } else if (path === 'name.formatted') {
      if (typeof op.value !== 'string') throw new ScimError('name.formatted is a string.', 400, 'invalidValue');
      out.formatted = op.value;
    } else if (!path && op.value && typeof op.value === 'object') {
      const v = op.value as Record<string, unknown>;
      if (typeof v.active === 'boolean') out.active = v.active;
      const n = v.name && typeof v.name === 'object' ? (v.name as Record<string, unknown>) : null;
      if (n && typeof n.formatted === 'string') out.formatted = n.formatted;
      if (out.active === undefined && out.formatted === undefined) throw new ScimError('Only active and name.formatted can be changed here.', 400, 'invalidPath');
    } else {
      throw new ScimError(`Attribute ${path || '(none)'} cannot be changed here; only active and name.formatted.`, 400, 'invalidPath');
    }
  }
  return out;
}
