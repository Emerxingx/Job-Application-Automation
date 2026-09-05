/**
 * Stage 21 (ADR-0036) - the operator's mart sweep: rebuild EVERY mart a
 * dashboard reads for the last N days (default 400) - usage, revenue, the
 * Stage 13 platform counts, the Stage 21 platform metrics and snapshots,
 * every organisation's product reporting, the subscription cohorts and the
 * candidate outcome marts. There is no scheduler (ADR-0011 is not built);
 * this is what a nightly cron would call, and a mart's freshness on its page
 * says whether it has been.
 *
 *   npm run analytics:rollup            # last 400 days
 *   npm run analytics:rollup -- 30      # last 30 days
 *
 * Idempotent: every job replaces whole scopes and converges on the same rows.
 * A failed job is reported and the others still run.
 */
import { db } from '@/lib/db';
import { rollupAll } from '@/lib/analytics/rollups';

async function main() {
  const days = Math.max(1, Number.parseInt(process.argv[2] ?? '400', 10) || 400);
  const end = new Date(Date.now() + 86400_000);
  const start = new Date(end.getTime() - days * 86400_000);
  const results = await rollupAll({ start, end });
  let failed = 0;
  for (const r of results) {
    if (r.status === 'failed') failed += 1;
    console.log(`[analytics] ${r.job}: ${r.status} - ${r.days} days, ${r.rowsRead} rows read, ${r.rowsWritten} rows written${r.error ? ` - ${r.error}` : ''}`);
  }
  await db.$disconnect();
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
