/**
 * Stage 24 (ADR-0038) - record a break-glass session: `npm run ops:break-glass`.
 *
 *   npm run ops:break-glass -- --actor ops@example.com --reason "INC-12 database recovery" --ticket INC-12
 *   npm run ops:break-glass -- --close <audit row id> --summary "restored Invoice from dump; 0 rows changed"
 *
 * A declared intent, written to `AuditLog` before a person opens a direct
 * session and when they close it (`docs/operations/BREAK_GLASS.md`); the
 * provider's own logging is the enforcement. The actor must be on
 * STAFF_EMAILS. The command holds no credential of its own.
 */
import { db } from '@/lib/db';
import { redactError } from '@/lib/log';
import { closeBreakGlass, openBreakGlass } from '@/lib/ops/break-glass';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const close = arg('close');
  if (close) {
    const r = await closeBreakGlass({ openedId: close, summary: arg('summary') ?? '' });
    console.log(`[break-glass] closed ${r.ticket} (opened as ${r.id} by ${r.actor})`);
  } else {
    const r = await openBreakGlass({ actor: arg('actor') ?? '', reason: arg('reason') ?? '', ticket: arg('ticket') ?? '' });
    console.log(`[break-glass] recorded ${r.id}. Close it with: npm run ops:break-glass -- --close ${r.id} --summary "<what changed>"`);
  }
  await db.$disconnect();
}

main().catch((error) => {
  console.error(`[break-glass] ${redactError(error).message}`);
  process.exit(1);
});
