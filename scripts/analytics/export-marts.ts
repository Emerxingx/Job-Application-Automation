/**
 * Stage 21 (ADR-0036) - the warehouse extraction: write each mart's rows for a
 * day range as one CSV per mart per day under `warehouse/<mart>/<day>.csv`
 * in the platform's object storage.
 *
 *   npm run analytics:export                                   # last 30 days, default marts
 *   npm run analytics:export -- --days 90
 *   npm run analytics:export -- --from 2026-08-01 --to 2026-08-31
 *   npm run analytics:export -- --marts DailyMetric,CandidateOutcomeMart   # a user-scoped mart only by name
 *
 * The user-scoped candidate marts are never exported unless named (ADR-0015).
 * Every run writes an `analytics.exported` audit row naming the marts, the
 * range and the number of files - the operator's action is on the record.
 */
import { db } from '@/lib/db';
import { DEFAULT_EXPORT_MARTS, exportMarts } from '@/lib/analytics/warehouse/export';
import { MART_REGISTRY, type MartName } from '@/lib/analytics/platform/dictionary';
import { parseDayKey, rangeOfDays } from '@/lib/analytics/time';
import { recordSecurityEvent } from '@/lib/security-audit';
import { redactError } from '@/lib/log';

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : null;
}

async function main() {
  const from = arg('from');
  const to = arg('to');
  const days = Math.max(1, Number.parseInt(arg('days') ?? '30', 10) || 30);
  let range;
  if (from || to) {
    if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error('--from and --to are both YYYY-MM-DD');
    const start = parseDayKey(from);
    const end = new Date(parseDayKey(to).getTime() + 86_400_000);
    if (start >= end) throw new Error('--from must not be after --to');
    range = { start, end };
  } else {
    range = rangeOfDays(days);
  }
  const named = arg('marts');
  const marts: MartName[] = named ? named.split(',').map((m) => m.trim()).filter(Boolean) as MartName[] : [...DEFAULT_EXPORT_MARTS];
  for (const m of marts) if (!Object.hasOwn(MART_REGISTRY, m)) throw new Error(`Unknown mart: ${m} (known: ${Object.keys(MART_REGISTRY).join(', ')})`);

  const result = await exportMarts(range, { marts });
  await recordSecurityEvent({
    event: 'analytics.exported',
    actor: { type: 'system' },
    entityType: 'warehouse_export',
    summary: `Warehouse extraction of ${result.marts.join(', ')} for ${result.days} day(s): ${result.files.length} file(s).`,
    detail: { marts: result.marts.join(','), windowStart: range.start.toISOString(), windowEnd: range.end.toISOString(), files: result.files.length, userScoped: result.marts.some((m) => MART_REGISTRY[m].scope === 'user') },
  });
  console.log(`[warehouse] ${result.files.length} file(s) for ${result.marts.length} mart(s) over ${result.days} day(s)`);
  for (const f of result.files) console.log(`  ${f.key} (${f.rows} rows)`);
  await db.$disconnect();
}

main().catch((error) => {
  console.error(redactError(error).message);
  process.exit(1);
});
