/**
 * Stage 21 (ADR-0036) - the warehouse extraction: write every system- and
 * organisation-scoped mart for the last N days (default 30) as one CSV per
 * mart per day under warehouse/<mart>/<day>.csv in the platform's object
 * storage, for a warehouse loader to pick up. See
 * docs/architecture/WAREHOUSE_EXTRACTION.md.
 *
 *   npm run analytics:export            # last 30 days
 *   npm run analytics:export -- 7       # last 7 days
 */
import { db } from '@/lib/db';
import { exportMarts } from '@/lib/analytics/warehouse/export';

async function main() {
  const days = Math.max(1, Number.parseInt(process.argv[2] ?? '30', 10) || 30);
  const end = new Date(Date.now() + 86400_000);
  const start = new Date(end.getTime() - days * 86400_000);
  const result = await exportMarts({ start, end });
  console.log(`[warehouse] ${result.files.length} file(s) for ${result.marts.length} mart(s) over ${result.days} day(s)`);
  for (const f of result.files) console.log(`  ${f.key} (${f.rows} rows)`);
  await db.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
