import { db } from '@/lib/db';
import { isAllowlistedStaffEmail } from '@/lib/crm/allowlist';
import { hashEmail, recordSecurityEvent } from '@/lib/security-audit';

/**
 * Stage 24 (ADR-0038) - break-glass sessions, recorded.
 *
 * A row in `AuditLog` BEFORE a person opens a direct session on the
 * production database or the object store, and one when they close it
 * (`docs/operations/BREAK_GLASS.md`). What a row is: a DECLARED intent -
 * who says they opened it, why, under which ticket, when. What it is not:
 * an enforcement. Anyone holding the credential can skip the row or name
 * someone else; the provider's own connection and statement logging is the
 * only record of what a session actually did (review M5). Two things
 * narrow the claim: the actor must be on the staff allow-list
 * (`STAFF_EMAILS`), and the address is recorded as a digest as well as in
 * clear, so a later query can match it against sign-in events.
 */

export class BreakGlassError extends Error {}

function clean(value: string | undefined, max: number): string {
  return (value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

/** Records the opening; returns the audit row id the close must name. Refuses an actor who is not staff. */
export async function openBreakGlass(input: { actor: string; reason: string; ticket: string }, env: NodeJS.ProcessEnv = process.env): Promise<{ id: string }> {
  const actor = clean(input.actor, 200).toLowerCase();
  const reason = clean(input.reason, 500);
  const ticket = clean(input.ticket, 100);
  if (!actor || !reason || !ticket) throw new BreakGlassError('--actor <email>, --reason "<incident or recovery>" and --ticket <reference> are all required BEFORE the session is opened.');
  if (!isAllowlistedStaffEmail(actor, env.STAFF_EMAILS)) throw new BreakGlassError('The actor is not on the staff allow-list (STAFF_EMAILS); a break-glass session is opened by staff only.');
  await recordSecurityEvent(
    { event: 'ops.break_glass.opened', actor: { type: 'staff', email: actor }, entityType: 'BreakGlass', entityId: ticket, summary: `Break-glass session opened for ${ticket}: ${reason}`, reason, detail: { ticket, actorEmailHash: hashEmail(actor) } },
    db,
    { strict: true },
  );
  const row = await db.auditLog.findFirst({ where: { action: 'ops.break_glass.opened', entityId: ticket, actorEmail: actor }, orderBy: { createdAt: 'desc' }, select: { id: true } });
  if (!row) throw new BreakGlassError('The audit row was not written; do NOT open the session.');
  return row;
}

/** Records the closing against the opening row; the ticket is the entity on both rows so one query returns the pair. */
export async function closeBreakGlass(input: { openedId: string; summary: string }): Promise<{ id: string; ticket: string; actor: string }> {
  const opened = await db.auditLog.findUnique({ where: { id: clean(input.openedId, 100) } });
  if (!opened || opened.action !== 'ops.break_glass.opened') throw new BreakGlassError('--close needs the id of an ops.break_glass.opened row.');
  const summary = clean(input.summary, 500);
  if (!summary) throw new BreakGlassError('--summary is required on close: what changed, in words (tables and counts, never a value).');
  await recordSecurityEvent(
    { event: 'ops.break_glass.closed', actor: { type: 'staff', email: opened.actorEmail }, entityType: 'BreakGlass', entityId: opened.entityId, summary: `Break-glass session closed: ${summary}`, reason: opened.reason ?? undefined, detail: { openedId: opened.id, actorEmailHash: hashEmail(opened.actorEmail) } },
    db,
    { strict: true },
  );
  return { id: opened.id, ticket: opened.entityId, actor: opened.actorEmail };
}
