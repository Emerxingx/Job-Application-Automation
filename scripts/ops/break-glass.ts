/**
 * Stage 24 (ADR-0038) - record a break-glass session: `npm run ops:break-glass`.
 *
 *   npm run ops:break-glass -- --actor ops@example.com --reason "INC-12 database recovery" --ticket INC-12
 *   npm run ops:break-glass -- --close <audit row id> --summary "restored Invoice from dump; 0 rows changed"
 *
 * Writes ONE `AuditLog` row BEFORE a person opens a direct session on the
 * production database or the object store, and one when they close it
 * (`docs/operations/BREAK_GLASS.md`). The row carries who, why, the ticket
 * and the time - never a credential, never a value read or written. The
 * command holds no credential of its own: it writes through the system
 * client like every other operator command, and the session it records is
 * opened separately by the person, with the secret they hold.
 */
import { db } from '@/lib/db';
import { recordSecurityEvent } from '@/lib/security-audit';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const close = arg('close');
  if (close) {
    const opened = await db.auditLog.findUnique({ where: { id: close } });
    if (!opened || opened.action !== 'ops.break_glass.opened') throw new Error('--close needs the id of an ops.break_glass.opened row.');
    const summary = (arg('summary') ?? '').trim();
    if (!summary) throw new Error('--summary is required on close: what changed, in words (tables and counts, never a value).');
    await recordSecurityEvent({ event: 'ops.break_glass.closed', actor: { type: 'staff', email: opened.actorEmail }, entityType: 'BreakGlass', entityId: opened.id, summary: `Break-glass session closed: ${summary.slice(0, 500)}`, reason: opened.reason ?? undefined });
    console.log(`[break-glass] closed ${opened.id} (opened ${opened.createdAt.toISOString()} by ${opened.actorEmail})`);
    await db.$disconnect();
    return;
  }
  const actor = (arg('actor') ?? '').trim();
  const reason = (arg('reason') ?? '').trim();
  const ticket = (arg('ticket') ?? '').trim();
  if (!actor || !reason || !ticket) throw new Error('--actor <email>, --reason "<incident or recovery>" and --ticket <reference> are all required BEFORE the session is opened.');
  await recordSecurityEvent({ event: 'ops.break_glass.opened', actor: { type: 'staff', email: actor }, entityType: 'BreakGlass', entityId: ticket, summary: `Break-glass session opened for ${ticket}: ${reason.slice(0, 500)}`, reason, detail: { ticket } });
  const row = await db.auditLog.findFirst({ where: { action: 'ops.break_glass.opened', entityId: ticket }, orderBy: { createdAt: 'desc' }, select: { id: true } });
  console.log(`[break-glass] recorded ${row?.id ?? '(no row - the audit write failed; do NOT open the session)'}. Close it with: npm run ops:break-glass -- --close ${row?.id ?? '<id>'} --summary "<what changed>"`);
  await db.$disconnect();
}

main().catch((error) => {
  console.error(`[break-glass] ${error instanceof Error ? error.message : 'failed'}`);
  process.exit(1);
});
