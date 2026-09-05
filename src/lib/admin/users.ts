import { db } from '@/lib/db';
import { revokeAllSessions } from '@/lib/auth';
import { revokeAllDeviceSessions } from '@/lib/integrations/device-sessions';
import { STAFF_ROLES, isStaffRole, type StaffContext } from '@/lib/crm/auth';
import { recordSecurityEvent, type RequestMeta } from '@/lib/security-audit';
import { AdminError } from './organizations';

/**
 * Stage 20 (ADR-0035) - user administration by staff: the platform role
 * (member, or one of the staff ranks) and session revocation. Both are
 * ASSIGNMENT of a permission defined in code (ADR-0019 Tier 1); no rank is
 * defined here, and the console's two-lock gate (STAFF_EMAILS AND the role)
 * still applies to whoever is promoted - a role alone opens nothing.
 */
export const PLATFORM_ROLES = ['member', ...STAFF_ROLES] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export function isPlatformRole(value: unknown): value is PlatformRole {
  return value === 'member' || isStaffRole(String(value));
}

export async function findUserByEmail(email: string) {
  const user = await db.user.findUnique({ where: { email: email.trim().toLowerCase() }, select: { id: true, email: true, fullName: true, role: true, anonymizedAt: true, onboardedAt: true, createdAt: true, emailVerifiedAt: true, passwordChangedAt: true } });
  if (!user) return null;
  const [sessions, memberships] = await Promise.all([
    db.session.findMany({ where: { userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true, method: true, createdAt: true, lastSeenAt: true, expiresAt: true }, orderBy: { lastSeenAt: 'desc' } }),
    db.membership.findMany({ where: { userId: user.id, removedAt: null }, select: { organizationId: true, role: true, serviceRole: true, acceptedAt: true, organization: { select: { name: true, type: true, status: true } } } }),
  ]);
  return { ...user, sessions, memberships };
}

/** Change a person's platform role. A staff member cannot change their own; an erased account is not promotable. */
export async function setPlatformRole(staff: StaffContext, userId: string, role: PlatformRole, reason: string, meta?: RequestMeta) {
  if (!isPlatformRole(role)) throw new AdminError('Unknown role.', 422);
  if (!reason.trim()) throw new AdminError('A reason is required.', 422);
  if (userId === staff.id) throw new AdminError('You cannot change your own role; another administrator does that.', 403);
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, email: true, role: true, anonymizedAt: true } });
  if (!user) throw new AdminError('No such user.', 404);
  if (user.anonymizedAt) throw new AdminError('That account was erased.', 409);
  if (user.role === role) throw new AdminError(`The account is already ${role}.`, 409);
  const updated = await db.user.update({ where: { id: user.id }, data: { role }, select: { id: true, email: true, role: true } });
  await recordSecurityEvent(
    { event: 'staff.role.set', user: { id: user.id, email: user.email, role }, actor: { type: 'staff', id: staff.id, email: staff.email, role: staff.role }, entityType: 'User', entityId: user.id, summary: `Platform role set: ${user.role} -> ${role}`, detail: { from: user.role, to: role }, reason: reason.trim().slice(0, 500), meta },
    db,
    { strict: true },
  );
  return updated;
}

/** Sign a person out everywhere (a compromised account, an offboarding). Audited as a staff action. */
export async function revokeUserSessions(staff: StaffContext, userId: string, reason: string, meta?: RequestMeta) {
  if (!reason.trim()) throw new AdminError('A reason is required.', 422);
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, email: true, role: true } });
  if (!user) throw new AdminError('No such user.', 404);
  // Web sessions AND device keys (review H2): "sign out everywhere" includes the phone.
  const count = await revokeAllSessions(user.id, 'staff_revoke');
  const devices = await revokeAllDeviceSessions(user.id, 'staff_revoke');
  await recordSecurityEvent(
    { event: 'auth.sessions.revoked_all', user, actor: { type: 'staff', id: staff.id, email: staff.email, role: staff.role }, entityType: 'User', entityId: user.id, summary: `Staff revoked ${count} session(s) and ${devices} device key(s)`, detail: { count, devices, by: 'staff' }, reason: reason.trim().slice(0, 500), meta },
    db,
    { strict: true },
  );
  return count + devices;
}
