/**
 * Freshness sweep for every ENABLED job source (Stage 06).
 *
 *   npm run jobs:freshness            # every enabled source, 24 h staleness
 *   npm run jobs:freshness -- mock 6  # one source, 6 h staleness
 *
 * Meant for a scheduler (cron, a platform job) — no scheduler exists in the
 * codebase yet (Stage 24 wires deployment). Each source goes through the
 * same gate as discovery; a refused source is recorded as such and skipped,
 * never worked around. Exit code 1 when any sweep failed.
 */
import { db } from '../../src/lib/db';
import { runRefresh } from '../../src/lib/connectors/pipeline';
import { ensureSourceRegistry } from '../../src/lib/connectors/registry';

async function main() {
  const [only, hours] = process.argv.slice(2);
  const staleAfterMs = (hours ? Number(hours) : 24) * 3_600_000;
  await ensureSourceRegistry();
  const sources = await db.jobSource.findMany({ where: only ? { key: only } : { status: { in: ['enabled', 'degraded'] } }, orderBy: { priority: 'asc' } });
  let failed = 0;
  for (const source of sources) {
    try {
      const run = await runRefresh(source.key, { staleAfterMs });
      console.log(`[freshness] ${source.key}: ${run.status} — checked ${run.discovered}, re-seen ${run.updated}, closed ${run.closed}${run.error ? ` (${run.error})` : ''}`);
      if (run.status !== 'ok') failed += 1;
    } catch (error) {
      failed += 1;
      console.error(`[freshness] ${source.key}: refused — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await db.$disconnect();
  process.exit(failed ? 1 : 0);
}

main();
