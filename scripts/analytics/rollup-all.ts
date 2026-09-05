/**
 * Stage 21 (ADR-0036) - the operator's sweep: rebuild every mart a dashboard
 * reads over the last N whole UTC days (default 400), ending today.
 *
 *   npm run analytics:rollup            # 400 days
 *   npm run analytics:rollup -- 30      # 30 days
 *
 * Idempotent: every job replaces whole scopes and converges on the same rows.
 * A failed job is reported and the others still run; the exit code is 1 if
 * any failed. There is no scheduler: this is the command a stale freshness
 * line asks for.
 */
import { db } from '@/lib/db';
import { rollupAll } from '@/lib/analytics/rollups';
import { rangeOfDays } from '@/lib/analytics/time';

async function main() {
  const days = Math.max(1, Number.parseInt(process.argv[2] ?? '400', 10) || 400);
  // Review L16: the window ends at the end of TODAY, never tomorrow.
  const results = await rollupAll(rangeOfDays(days));
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
