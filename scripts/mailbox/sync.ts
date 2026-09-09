/**
 * Stage 11 — the operator's sync sweep: every connected mailbox and
 * calendar, then the retention prune for every account. There is no
 * scheduler (ADR-0011 is not built); this is what one would call.
 *
 *   npm run mailbox:sync
 *
 * Tokens are decrypted only inside the service, on the system client; this
 * script sees counts and never a subject.
 */
import { db } from '@/lib/db';
import { pruneReferences, syncConnection } from '@/lib/mailbox/service';
import { redactError } from '@/lib/log';

async function main() {
  const connections = await db.mailboxConnection.findMany({ where: { status: 'connected' }, select: { id: true, userId: true, provider: true, kind: true } });
  let ok = 0;
  let failed = 0;
  for (const c of connections) {
    try {
      const r = await syncConnection(c.id);
      ok += 1;
      console.log(`[mailbox] ${c.provider} ${c.kind} ${c.id}: ${r.threads} threads (${r.newThreads} new, ${r.auto} auto, ${r.pending} pending), ${r.calendarEvents} events, ${r.integrationEvents} integration events`);
    } catch (error) {
      failed += 1;
      console.error(`[mailbox] ${c.provider} ${c.kind} ${c.id} failed:`, redactError(error).message);
    }
  }
  let pruned = 0;
  for (const userId of new Set(connections.map((c) => c.userId))) pruned += await pruneReferences(userId);
  console.log(`[mailbox] synced ${ok}, failed ${failed}, pruned ${pruned} references past the retention window`);
  await db.$disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(redactError(error).message);
  process.exit(1);
});
