/**
 * Stage 18 (ADR-0033) - the employer permission set, a NAMED SET over the
 * organisation ladder (ROLE_PERMISSION_MATRIX.md "Employer organisation"):
 * admin (the organisation's owner or admin), recruiter, hiring_manager,
 * interviewer, viewer. `Membership.serviceRole` names it; null or an
 * unrecognised value is viewer, the weakest, so a role this code does not
 * know can never widen access.
 */
import { meetsRole } from '@/lib/tenancy/roles';

export const EMPLOYER_ROLES = ['recruiter', 'hiring_manager', 'interviewer', 'viewer'] as const;
export type EmployerServiceRole = (typeof EMPLOYER_ROLES)[number];
export type EmployerRole = 'admin' | EmployerServiceRole;

export function isEmployerRole(value: unknown): value is EmployerServiceRole {
  return typeof value === 'string' && (EMPLOYER_ROLES as readonly string[]).includes(value);
}

export function employerRoleOf(membership: { role: string; serviceRole: string | null }): EmployerRole {
  if (meetsRole(membership.role, 'admin')) return 'admin';
  return isEmployerRole(membership.serviceRole) ? membership.serviceRole : 'viewer';
}

/** Requisitions: admin and recruiter full; a hiring manager their own; interviewer and viewer read. */
export function canWriteRequisition(role: EmployerRole, r: { hiringManagerId: string | null; recruiterId: string | null }, userId: string): boolean {
  if (role === 'admin' || role === 'recruiter') return true;
  if (role === 'hiring_manager') return r.hiringManagerId === userId;
  return false;
}
export function canCreateRequisition(role: EmployerRole): boolean {
  return role === 'admin' || role === 'recruiter' || role === 'hiring_manager';
}
/** Candidate search, talent pools, disclosure requests: admin and recruiter act; a hiring manager reads. */
export function canSource(role: EmployerRole): boolean {
  return role === 'admin' || role === 'recruiter';
}
export function canReadSourcing(role: EmployerRole): boolean {
  return canSource(role) || role === 'hiring_manager';
}
/** Pipeline moves: admin and recruiter; a hiring manager on their own requisitions. */
export function canMovePipeline(role: EmployerRole, r: { hiringManagerId: string | null; recruiterId: string | null }, userId: string): boolean {
  return canWriteRequisition(role, r, userId);
}
/** Interview feedback: the interviewers named on it, plus anyone who may move the pipeline. */
export function canWriteInterview(role: EmployerRole, r: { hiringManagerId: string | null; recruiterId: string | null }, interviewerIds: string[], userId: string): boolean {
  return canMovePipeline(role, r, userId) || (role === 'interviewer' && interviewerIds.includes(userId));
}
/** Offers: admin and the hiring manager of the requisition extend and decide; a recruiter reads them (ROLE_PERMISSION_MATRIX.md, Employer: Offers). */
export function canDecideOffer(role: EmployerRole, r: { hiringManagerId: string | null; recruiterId: string | null }, userId: string): boolean {
  return role === 'admin' || (role === 'hiring_manager' && r.hiringManagerId === userId);
}
/** Reporting: everyone but an interviewer reads the organisation's numbers (the matrix's "—" for interviewers). */
export function canReadReporting(role: EmployerRole): boolean {
  return role !== 'interviewer';
}
