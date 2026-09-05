/**
 * Stage 19 (ADR-0034) - the staffing-agency permission set, as a NAMED SET
 * over the organisation ladder (src/lib/tenancy/roles.ts), not new rungs.
 *
 * ROLE_PERMISSION_MATRIX.md "Staffing agency": owner and admin of the
 * organisation are `admin`; `Membership.serviceRole` names `recruiter`,
 * `delivery` and `finance`. A recruiter OWNS engagements and placements
 * (write their own, read the rest); delivery writes engagements and
 * placements; finance reads the commercial rows and owns invoicing; an
 * unknown or null role is `viewer`, which the matrix does not list and which
 * therefore sees nothing commercial - the weakest level, so a role this code
 * does not know can never widen access.
 */
import { meetsRole } from '@/lib/tenancy/roles';

export const STAFFING_ROLES = ['recruiter', 'delivery', 'finance', 'viewer'] as const;
export type StaffingServiceRole = (typeof STAFFING_ROLES)[number];
export type StaffingRole = 'admin' | StaffingServiceRole;

export function isStaffingRole(value: unknown): value is StaffingServiceRole {
  return typeof value === 'string' && (STAFFING_ROLES as readonly string[]).includes(value);
}

export function staffingRoleOf(membership: { role: string; serviceRole: string | null }): StaffingRole {
  if (meetsRole(membership.role, 'admin')) return 'admin';
  return isStaffingRole(membership.serviceRole) ? membership.serviceRole : 'viewer';
}

type Owned = { ownerRecruiterId: string | null };

/** Client contracts: admin writes; recruiter, delivery and finance read. */
export function canWriteContract(role: StaffingRole): boolean {
  return role === 'admin';
}
export function canReadContract(role: StaffingRole): boolean {
  return role !== 'viewer';
}
/** Fee structures: admin writes; recruiter and finance read; delivery does not see fees. */
export function canWriteFee(role: StaffingRole): boolean {
  return role === 'admin';
}
export function canReadFee(role: StaffingRole): boolean {
  return role === 'admin' || role === 'recruiter' || role === 'finance';
}
/** Engagements: admin and delivery write any; a recruiter writes their own; finance reads. */
export function canWriteEngagement(role: StaffingRole, e: Owned, userId: string): boolean {
  if (role === 'admin' || role === 'delivery') return true;
  if (role === 'recruiter') return e.ownerRecruiterId === userId || e.ownerRecruiterId === null;
  return false;
}
export function canCreateEngagement(role: StaffingRole): boolean {
  return role === 'admin' || role === 'delivery' || role === 'recruiter';
}
export function canReadEngagement(role: StaffingRole): boolean {
  return role !== 'viewer';
}
/** Representation consent: admin any; a recruiter their own engagement; delivery reads; finance does not see it. */
export function canRequestRepresentation(role: StaffingRole, e: Owned, userId: string): boolean {
  return role === 'admin' || (role === 'recruiter' && (e.ownerRecruiterId === userId || e.ownerRecruiterId === null));
}
export function canReadRepresentation(role: StaffingRole): boolean {
  return role === 'admin' || role === 'recruiter' || role === 'delivery';
}
/** Placements: admin and delivery write any; a recruiter their own engagement's; finance reads. */
export function canWritePlacement(role: StaffingRole, e: Owned, userId: string): boolean {
  return canWriteEngagement(role, e, userId);
}
/** Placement invoicing: finance full, admin writes; nobody else sees it. */
export function canInvoice(role: StaffingRole): boolean {
  return role === 'admin' || role === 'finance';
}
export function canReadInvoice(role: StaffingRole): boolean {
  return canInvoice(role);
}
/** Recruiter productivity: admin, delivery and finance the organisation's; a recruiter their own. */
export function canReadProductivity(role: StaffingRole): boolean {
  return role !== 'viewer';
}
