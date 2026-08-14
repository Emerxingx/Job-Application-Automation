/**
 * The reporting window behind /dashboard/analytics.
 *
 * Pure: no database, no React, no client-only imports — the server page and the
 * client period picker both read from here, so the label under the picker and
 * the numbers in the cards can never disagree about what "last 30 days" means.
 *
 * Every window is a half-open UTC `[start, end)` interval, matching the
 * convention in src/lib/analytics/time.ts. `previous` is the window of exactly
 * the same length that ends where `range` begins, which is what makes the
 * period-over-period deltas honest: comparing 30 days against 30 days, never
 * against a partial month.
 */

import { addUtcDays, dayKey, startOfUtcDay } from '@/lib/analytics/time';
import type { DateRange, Granularity } from '@/lib/analytics/types';

/** Mirrors `DateRangePreset` in src/components/filters.tsx, value for value. */
export type PeriodKey = '7d' | '30d' | '90d' | '12m' | 'all';

export const PERIOD_KEYS: readonly PeriodKey[] = ['7d', '30d', '90d', '12m', 'all'];

export const DEFAULT_PERIOD: PeriodKey = '30d';

const PERIOD_LABELS: Record<PeriodKey, string> = {
  '7d': 'the last 7 days',
  '30d': 'the last 30 days',
  '90d': 'the last 90 days',
  '12m': 'the last 12 months',
  all: 'your whole search',
};

/** Days covered by each fixed-length preset. `all` has no fixed length. */
const PERIOD_DAYS: Record<Exclude<PeriodKey, 'all'>, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '12m': 365,
};

/**
 * Bucket size per preset.
 *
 * A 90-day series drawn per day is 90 columns of noise on a phone; per week it
 * is 13 columns that still show the trend. `all` is monthly for the same reason
 * plus a hard one — `buildBuckets` truncates past 4000 buckets.
 */
const PERIOD_GRANULARITY: Record<PeriodKey, Granularity> = {
  '7d': 'day',
  '30d': 'day',
  '90d': 'week',
  '12m': 'month',
  all: 'month',
};

/** Narrow an untrusted `?period=` value, falling back rather than throwing. */
export function parsePeriod(value: string | string[] | undefined): PeriodKey {
  const first = Array.isArray(value) ? value[0] : value;
  return PERIOD_KEYS.includes(first as PeriodKey) ? (first as PeriodKey) : DEFAULT_PERIOD;
}

export interface ResolvedPeriod {
  key: PeriodKey;
  /** Sentence fragment: "in the last 30 days". */
  label: string;
  granularity: Granularity;
  range: DateRange;
  /** The equally long window immediately before `range`. */
  previous: DateRange;
  /**
   * False for `all`, where the preceding window is empty by construction and a
   * "+100%" delta against nothing would be a lie.
   */
  comparable: boolean;
  /** `YYYY-MM-DD` bounds for the export endpoints. `from` is null when unbounded. */
  from: string | null;
  to: string;
}

export interface ResolvePeriodOptions {
  now?: Date;
  /** Account creation date — the natural floor for the `all` window. */
  since?: Date | null;
}

/** Turn a preset into the concrete windows the page queries with. */
export function resolvePeriod(
  key: PeriodKey,
  options: ResolvePeriodOptions = {},
): ResolvedPeriod {
  const now = options.now ?? new Date();
  // End of the window is midnight tomorrow UTC, so activity from earlier today
  // is inside the current period rather than falling off the end of it.
  const end = addUtcDays(startOfUtcDay(now), 1);

  const start =
    key === 'all'
      ? startOfUtcDay(options.since ?? addUtcDays(end, -PERIOD_DAYS['12m'] * 5))
      : addUtcDays(end, -PERIOD_DAYS[key]);

  const span = Math.max(1, end.getTime() - start.getTime());
  const range: DateRange = { start, end };
  const previous: DateRange = { start: new Date(start.getTime() - span), end: start };

  return {
    key,
    label: PERIOD_LABELS[key],
    granularity: PERIOD_GRANULARITY[key],
    range,
    previous,
    comparable: key !== 'all',
    from: key === 'all' ? null : dayKey(start),
    // `end` is exclusive; the export endpoints treat `to` as an inclusive day.
    to: dayKey(new Date(end.getTime() - 1)),
  };
}
