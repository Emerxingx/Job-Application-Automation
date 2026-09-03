/**
 * Stage 13 - the operator's mart sweep: rebuild the candidate outcome, match
 * and benchmark marts for the last N days (default 400) for every user.
 * There is no scheduler (ADR-0011 is not built); this is what one would call.
 *
 *   npm run analytics:rollup            # last 400 days
 *   npm run analytics:rollup -- 30      # last 30 days
 *
 * Idempotent: every run replaces whole days and converges on the same rows.
 */
import { db } from '@/lib/db';
import { rollupCandidateOutcomes } from '@/lib/analytics/candidate/rollup';

async function main() {
  const days = Math.max(1, Number.parseInt(process.argv[2] ?? '400', 10) || 400);
  const end = new Date(Date.now() + 86400_000);
  const start = new Date(end.getTime() - days * 86400_000);
  const result = await rollupCandidateOutcomes({ start, end });
  console.log(`[analytics] ${result.job}: ${result.days} days, ${result.applicationsRead} applications and ${result.matchesRead} matches read, ${result.outcomeRows} outcome rows, ${result.matchRows} match rows, ${result.benchmarkRows} benchmark rows`);
  await db.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
