import { db } from '@/lib/db';
import { recordSecurityEvent, type RequestMeta } from '@/lib/security-audit';
import type { StaffContext } from '@/lib/crm/auth';
import { VERIFIED_TYPES, createOrganization } from '@/lib/tenancy/organizations';
import { isOrganizationType, type OrganizationType } from '@/lib/tenancy/roles';
import { isEmailDomain } from '@/lib/sso/oidc';
import { describeSsoConnection } from '@/lib/sso/service';

/**
 * Stage 20 (ADR-0035) - platform administration of organisations, on the
 * SYSTEM client, by JobPilot staff. Every change carries a reason and writes
 * an audit row with the before/after values; the routes add step-up.
 *
 * Tenant-level POLICY lives on the organisation row and is set HERE, never by
 * the organisation's own admins: whether members must sign in through SSO,
 * which email domains may be invited or provisioned, and the longest session
 * the platform issues them. A policy is a Tier-1 setting (ADR-0019): it
 * narrows what a tenant's members may do; it never widens a platform rule.
 */
export class AdminError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'AdminError';
    this.status = status;
  }
}

export const ORGANIZATION_ADMIN_STATUSES = ['active', 'suspended'] as const;

export async function listOrganizations(query: { q?: string; take?: number } = {}) {
  const q = query.q?.trim();
  const rows = await db.organization.findMany({
    where: { type: { not: 'personal' }, ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { slug: { contains: q.toLowerCase() } }] } : {}) },
    orderBy: [{ createdAt: 'desc' }],
    take: query.take ?? 100,
    select: { id: true, name: true, slug: true, type: true, status: true, verifiedAt: true, verifiedByEmail: true, requireSso: true, allowedEmailDomains: true, sessionMaxHours: true, createdAt: true, _count: { select: { memberships: { where: { acceptedAt: { not: null }, removedAt: null } } } }, ssoConnection: { select: { status: true, emailDomain: true } } },
  });
  return rows.map((o) => ({ ...o, allowedEmailDomains: parseDomains(o.allowedEmailDomains), members: o._count.memberships, sso: o.ssoConnection ? { status: o.ssoConnection.status, emailDomain: o.ssoConnection.emailDomain } : null }));
}

export function parseDomains(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((d): d is string => typeof d === 'string') : [];
  } catch {
    return [];
  }
}

/** Staff create a verified organisation for an existing account, which becomes its owner. The type is one that self-service refuses. */
export async function createVerifiedOrganization(staff: StaffContext, input: { name: string; type: OrganizationType; ownerEmail: string; billingEmail?: string }, reason: string, meta?: RequestMeta) {
  if (!isOrganizationType(input.type) || !VERIFIED_TYPES.has(input.type)) throw new AdminError('Staff create verified organisations only: employer, service_provider or staffing_agency.', 422);
  if (!reason.trim()) throw new AdminError('A reason is required (what was verified, and how).', 422);
  const owner = await db.user.findUnique({ where: { email: input.ownerEmail.trim().toLowerCase() }, select: { id: true, email: true, anonymizedAt: true } });
  if (!owner || owner.anonymizedAt) throw new AdminError('No account exists for the owner address; the person signs up first.', 404);
  const org = await createOrganization(owner.id, { name: input.name.trim(), type: input.type, billingEmail: (input.billingEmail ?? owner.email).trim().toLowerCase() }, { verifiedOrganization: true });
  const verified = await db.organization.update({ where: { id: org.id }, data: { verifiedAt: new Date(), verifiedByEmail: staff.email } });
  await recordSecurityEvent(
    { event: 'organization.verified', actor: { type: 'staff', id: staff.id, email: staff.email, role: staff.role }, entityType: 'Organization', entityId: org.id, summary: `Verified ${input.type} organisation created`, detail: { type: input.type, ownerUserId: owner.id }, reason: reason.trim().slice(0, 500), meta },
    db,
    { strict: true },
  );
  return verified;
}

/** Suspend or reactivate. A suspended organisation's members cannot establish its tenant context (requireTenant refuses) and its SSO does not sign anyone in. */
export async function setOrganizationStatus(staff: StaffContext, organizationId: string, status: (typeof ORGANIZATION_ADMIN_STATUSES)[number], reason: string, meta?: RequestMeta) {
  if (!(ORGANIZATION_ADMIN_STATUSES as readonly string[]).includes(status)) throw new AdminError('Unknown status.', 422);
  if (!reason.trim()) throw new AdminError('A reason is required.', 422);
  const org = await db.organization.findUnique({ where: { id: organizationId }, select: { id: true, type: true, status: true } });
  if (!org || org.type === 'personal') throw new AdminError('Organisation not found.', 404);
  if (org.status === status) throw new AdminError(`The organisation is already ${status}.`, 409);
  const updated = await db.organization.update({ where: { id: org.id }, data: { status } });
  await recordSecurityEvent(
    { event: status === 'suspended' ? 'organization.suspended' : 'organization.reactivated', actor: { type: 'staff', id: staff.id, email: staff.email, role: staff.role }, entityType: 'Organization', entityId: org.id, summary: `Organisation ${status}`, detail: { from: org.status, to: status }, reason: reason.trim().slice(0, 500), meta },
    db,
    { strict: true },
  );
  return updated;
}

export interface TenantPolicyInput {
  requireSso: boolean;
  allowedEmailDomains: string[];
  sessionMaxHours: number | null;
}

export async function setTenantPolicy(staff: StaffContext, organizationId: string, input: TenantPolicyInput, reason: string, meta?: RequestMeta) {
  if (!reason.trim()) throw new AdminError('A reason is required.', 422);
  const domains = [...new Set(input.allowedEmailDomains.map((d) => d.trim().toLowerCase()).filter(Boolean))];
  for (const d of domains) if (!isEmailDomain(d)) throw new AdminError(`${d} is not a domain name.`, 422);
  if (domains.length > 50) throw new AdminError('At most 50 domains.', 422);
  if (input.sessionMaxHours !== null && (!Number.isInteger(input.sessionMaxHours) || input.sessionMaxHours < 1 || input.sessionMaxHours > 24 * 30)) throw new AdminError('The session limit is a whole number of hours between 1 and 720, or empty for the platform default.', 422);
  const org = await db.organization.findUnique({ where: { id: organizationId }, select: { id: true, type: true, requireSso: true, allowedEmailDomains: true, sessionMaxHours: true, ssoConnection: { select: { status: true } } } });
  if (!org || org.type === 'personal') throw new AdminError('Organisation not found.', 404);
  // Requiring SSO with no enabled connection would lock every member out.
  if (input.requireSso && org.ssoConnection?.status !== 'enabled') throw new AdminError('Enable an SSO connection before requiring it.', 422);
  const updated = await db.organization.update({ where: { id: org.id }, data: { requireSso: input.requireSso, allowedEmailDomains: JSON.stringify(domains), sessionMaxHours: input.sessionMaxHours } });
  await recordSecurityEvent(
    { event: 'organization.policy.set', actor: { type: 'staff', id: staff.id, email: staff.email, role: staff.role }, entityType: 'Organization', entityId: org.id, summary: 'Tenant policy set', detail: { requireSsoBefore: org.requireSso, requireSso: input.requireSso, domainsBefore: org.allowedEmailDomains, domains: JSON.stringify(domains), sessionMaxHoursBefore: org.sessionMaxHours, sessionMaxHours: input.sessionMaxHours }, reason: reason.trim().slice(0, 500), meta },
    db,
    { strict: true },
  );
  return updated;
}

export async function organizationDetail(organizationId: string) {
  const org = await db.organization.findUnique({ where: { id: organizationId }, include: { memberships: { include: { user: { select: { id: true, email: true, fullName: true, anonymizedAt: true } } }, orderBy: { createdAt: 'asc' } }, scimTokens: { orderBy: { createdAt: 'desc' }, select: { id: true, prefix: true, createdByEmail: true, createdAt: true, lastUsedAt: true, revokedAt: true } } } });
  if (!org || org.type === 'personal') return null;
  const sso = await describeSsoConnection(org.id);
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    type: org.type,
    status: org.status,
    verifiedAt: org.verifiedAt,
    verifiedByEmail: org.verifiedByEmail,
    policy: { requireSso: org.requireSso, allowedEmailDomains: parseDomains(org.allowedEmailDomains), sessionMaxHours: org.sessionMaxHours },
    members: org.memberships.map((m) => ({ userId: m.userId, email: m.user.anonymizedAt ? '(erased)' : m.user.email, fullName: m.user.anonymizedAt ? '(erased)' : m.user.fullName, role: m.role, serviceRole: m.serviceRole, acceptedAt: m.acceptedAt, removedAt: m.removedAt })),
    sso,
    scimTokens: org.scimTokens,
  };
}

/** Whether an address may be invited into or provisioned for the organisation under its domain policy. No policy = any domain. */
export function domainAllowed(allowedEmailDomains: string[], email: string): boolean {
  if (allowedEmailDomains.length === 0) return true;
  const at = email.lastIndexOf('@');
  const domain = at < 0 ? '' : email.slice(at + 1).toLowerCase();
  return allowedEmailDomains.includes(domain);
}
