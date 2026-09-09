/**
 * Stage 23 (ADR-0037) - the retention sweep: `npm run retention:sweep`.
 *
 * Removes what DATA_RETENTION_MATRIX.md says expires by platform default
 * (sessions, AI runs, rollup runs, mailbox references, aggregate marts),
 * executes every account erasure whose fourteen-day grace period has
 * passed, and retries any file purge that failed. Writes one
 * `retention.swept` audit row. There is no scheduler: run it daily.
 */
import { db } from '@/lib/db';
import { sweepRetention } from '@/lib/privacy/retention';
import { redactError } from '@/lib/log';

async function main() {
  const report = await sweepRetention();
  for (const [k, v] of Object.entries(report)) console.log(`[retention] ${k}: ${v}`);
  await db.$disconnect();
  if (report.erasureErrors > 0) process.exit(1);
}

main().catch((error) => {
  console.error(redactError(error).message);
  process.exit(1);
});
