/**
 * Stage 17 (ADR-0032) - the service-provider permission set, as a NAMED SET
 * over the organisation ladder (src/lib/tenancy/roles.ts), not new rungs.
 *
 * ROLE_PERMISSION_MATRIX.md "Service provider": admin (the organisation's
 * owner or admin), supervisor, case_manager, viewer. A case manager is
 * ASSIGNMENT-GATED: they see only cases assigned to them. A member whose
 * `serviceRole` is null or unrecognised is a viewer - the weakest level -
 * so a role this code does not know can never widen access.
 */
import { meetsRole } from '@/lib/tenancy/roles';

export const SERVICE_ROLES = ['supervisor', 'case_manager', 'viewer'] as const;
export type ServiceRole = (typeof SERVICE_ROLES)[number];
export type CaseRole = 'admin' | ServiceRole;

export function isServiceRole(value: unknown): value is ServiceRole {
  return typeof value === 'string' && (SERVICE_ROLES as readonly string[]).includes(value);
}

/** The case role a membership confers. Owner and admin of the organisation are `admin`; otherwise the named set, defaulting to viewer. */
export function caseRoleOf(membership: { role: string; serviceRole: string | null }): CaseRole {
  if (meetsRole(membership.role, 'admin')) return 'admin';
  return isServiceRole(membership.serviceRole) ? membership.serviceRole : 'viewer';
}

/** Whether a role may open a given case record (the matrix's "Client case record" row). */
export function canOpenCase(role: CaseRole, c: { caseManagerId: string | null }, userId: string): boolean {
  if (role === 'admin' || role === 'supervisor') return true;
  if (role === 'case_manager') return c.caseManagerId === userId;
  return false;
}

/** Whether a role may write to a case (notes, assessments, tasks, outcomes). Supervisors read; the assigned case manager and admins write. */
export function canWriteCase(role: CaseRole, c: { caseManagerId: string | null }, userId: string): boolean {
  if (role === 'admin') return true;
  if (role === 'case_manager') return c.caseManagerId === userId;
  return false;
}

/** Whether a role may manage the caseload itself: invite clients, assign case managers, close cases. */
export function canManageCaseload(role: CaseRole): boolean {
  return role === 'admin' || role === 'supervisor';
}
