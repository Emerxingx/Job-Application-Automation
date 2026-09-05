import { db } from '@/lib/db';
import { IMPERSONATION_MAX_MINUTES, mintImpersonationToken } from '@/lib/auth';
import type { StaffContext } from '@/lib/crm/auth';
import { isAllowlistedStaffEmail } from '@/lib/crm/allowlist';
import { recordSecurityEvent, type RequestMeta } from '@/lib/security-audit';
import { AdminError } from './organizations';

/**
 * Stage 20 (ADR-0035) - support impersonation: READ-ONLY, REASON-REQUIRED,
 * TIME-BOXED. The `ImpersonationSession` model existed since the CRM design
 * and had no code; this makes it real.
 *
 * How it stays read-only: the staff member keeps their own session cookie and
 * gains a second, signed cookie naming an ImpersonationSession row. While
 * that cookie is live, `getSessionUserId()` answers with the TARGET's id -
 * every page renders as the person sees it - and `route()` refuses every
 * non-GET request with 403, so nothing can be written in their name. The
 * row's liveness is checked on every request (not ended, inside its window,
 * the staff member's OWN session still live), and ending it is a single
 * update. Everything is audited with the reason; the target's row carries the
 * staff email as a snapshot so the record survives offboarding.
 */
export { IMPERSONATION_MAX_MINUTES };

export async function startImpersonation(staff: StaffContext, input: { userId: string; reason: string; staffSessionId: string }, meta?: RequestMeta): Promise<{ id: string; token: string; endsAt: Date }> {
  const reason = input.reason.trim();
  if (reason.length < 10) throw new AdminError('A reason of at least ten characters is required (the ticket, the request).', 422);
  if (input.userId === staff.id) throw new AdminError('You cannot impersonate yourself.', 422);
  const target = await db.user.findUnique({ where: { id: input.userId }, select: { id: true, email: true, role: true, anonymizedAt: true } });
  if (!target) throw new AdminError('No such user.', 404);
  if (target.anonymizedAt) throw new AdminError('That account was erased.', 409);
  // Staff are never impersonated: their console access would become the
  // impersonator's, and a staff member's actions must always be their own.
  if (target.role !== 'member' || isAllowlistedStaffEmail(target.email, process.env.STAFF_EMAILS)) throw new AdminError('Staff accounts are not impersonated.', 403);
  const open = await db.impersonationSession.findFirst({ where: { staffId: staff.id, endedAt: null, startedAt: { gt: new Date(Date.now() - IMPERSONATION_MAX_MINUTES * 60_000) } }, select: { id: true } });
  if (open) throw new AdminError('End your current impersonation first.', 409);
  const row = await db.impersonationSession.create({ data: { staffId: staff.id, staffEmail: staff.email, userId: target.id, reason, readOnly: true, ipAddress: meta?.ip ?? null } });
  const endsAt = new Date(row.startedAt.getTime() + IMPERSONATION_MAX_MINUTES * 60_000);
  const token = await mintImpersonationToken({ impersonationId: row.id, userId: target.id, staffId: staff.id, staffSessionId: input.staffSessionId, expiresAt: endsAt });
  await recordSecurityEvent(
    { event: 'user.impersonation.started', user: target, actor: { type: 'staff', id: staff.id, email: staff.email, role: staff.role }, entityType: 'ImpersonationSession', entityId: row.id, summary: 'Support impersonation started (read-only)', detail: { targetUserId: target.id, minutes: IMPERSONATION_MAX_MINUTES, readOnly: true }, reason, meta },
    db,
    { strict: true },
  );
  return { id: row.id, token, endsAt };
}

/** End an impersonation. Called by the staff member (from the banner) or by anyone holding the row id with the staff id (the console list). */
export async function endImpersonation(input: { impersonationId: string; staffId: string; by: 'staff' | 'expiry' }, meta?: RequestMeta): Promise<boolean> {
  const result = await db.impersonationSession.updateMany({ where: { id: input.impersonationId, staffId: input.staffId, endedAt: null }, data: { endedAt: new Date() } });
  if (result.count === 0) return false;
  const row = await db.impersonationSession.findUniqueOrThrow({ where: { id: input.impersonationId }, select: { userId: true, staffEmail: true, staffId: true } });
  await recordSecurityEvent({ event: 'user.impersonation.ended', actor: { type: 'staff', id: row.staffId, email: row.staffEmail }, entityType: 'ImpersonationSession', entityId: input.impersonationId, summary: `Support impersonation ended (${input.by})`, detail: { targetUserId: row.userId, by: input.by }, meta });
  return true;
}

export async function listImpersonations(take = 50) {
  return db.impersonationSession.findMany({ orderBy: { startedAt: 'desc' }, take, select: { id: true, staffId: true, staffEmail: true, userId: true, reason: true, readOnly: true, startedAt: true, endedAt: true, user: { select: { email: true, anonymizedAt: true } } } });
}
