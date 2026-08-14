// UTC date arithmetic and time bucketing.
//
// Everything here is UTC, deliberately. `DailyUsageRollup.day`,
// `DailyMetric.day` and `DailyRevenueRollup.day` are all UTC `YYYY-MM-DD`
// strings, so any local-timezone arithmetic anywhere upstream would silently
// file events on the wrong day for half the world. date-fns is available but
// its helpers operate in the host's local zone, so this module does the
// arithmetic by hand against `Date.UTC` instead.
//
// No database access, no side effects: every function here is pure.

import type { DateRange, Granularity, TimeBucket } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Hard ceiling on how many columns one series may contain.
 *
 * A caller that passes a range of the year 1970 to the year 3000 gets a
 * truncated series instead of an out-of-memory loop.
 */
export const MAX_BUCKETS = 4000;

const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Instants
// ---------------------------------------------------------------------------

/** Midnight UTC on the day containing `value`. */
export function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

/** Add whole days. Exact in UTC — there is no daylight saving to skew it. */
export function addUtcDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * DAY_MS);
}

/** Midnight UTC on the Monday of the ISO week containing `value`. */
export function startOfUtcWeek(value: Date): Date {
  const day = startOfUtcDay(value);
  // getUTCDay(): Sunday = 0. Shift so Monday = 0.
  const offset = (day.getUTCDay() + 6) % 7;
  return addUtcDays(day, -offset);
}

/** Midnight UTC on the first of the month containing `value`. */
export function startOfUtcMonth(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}

/**
 * Move `months` months from the first of `value`'s month.
 *
 * Always lands on day 1, so there is no "January 31 + 1 month" ambiguity.
 */
export function addUtcMonths(value: Date, months: number): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + months, 1));
}

// ---------------------------------------------------------------------------
// Day keys
// ---------------------------------------------------------------------------

/** The UTC `YYYY-MM-DD` key used by every rollup table. */
export function dayKey(value: Date): string {
  return startOfUtcDay(value).toISOString().slice(0, 10);
}

/** The UTC `YYYY-MM` key used by month buckets. */
export function monthKey(value: Date): string {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Midnight UTC for a `YYYY-MM-DD` key. Throws on a malformed key. */
export function parseDayKey(key: string): Date {
  if (!DAY_KEY_PATTERN.test(key)) {
    throw new Error(`Invalid day key "${key}" — expected YYYY-MM-DD.`);
  }
  const parsed = new Date(`${key}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid day key "${key}" — not a real date.`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

/**
 * Clamp a range so `end` is never before `start`.
 *
 * A reversed range collapses to empty rather than being silently swapped: a
 * caller that mixed up its arguments should see no data, not plausible data
 * for a period it did not ask about.
 */
export function normalizeRange(range: DateRange): DateRange {
  return { start: range.start, end: range.end < range.start ? range.start : range.end };
}

/** Whether an instant falls in `[start, end)`. */
export function isWithin(range: DateRange, value: Date): boolean {
  return value >= range.start && value < range.end;
}

/**
 * The last `days` whole UTC days, including the day containing `now`.
 *
 * `rangeOfDays(1)` is today; `rangeOfDays(30)` is the last 30 days. The end is
 * midnight tomorrow UTC, so events happening later today are still included.
 */
export function rangeOfDays(days: number, now: Date = new Date()): DateRange {
  const safeDays = Math.max(1, Math.floor(days));
  const end = addUtcDays(startOfUtcDay(now), 1);
  return { start: addUtcDays(end, -safeDays), end };
}

/** Whole UTC days covering a range, as `YYYY-MM-DD` keys. Capped at MAX_BUCKETS. */
export function eachDayKey(range: DateRange): string[] {
  const { start, end } = normalizeRange(range);
  const keys: string[] = [];
  let cursor = startOfUtcDay(start);
  while (cursor < end && keys.length < MAX_BUCKETS) {
    keys.push(dayKey(cursor));
    cursor = addUtcDays(cursor, 1);
  }
  return keys;
}

/** The half-open range covering one `YYYY-MM-DD` day key. */
export function dayRange(key: string): DateRange {
  const start = parseDayKey(key);
  return { start, end: addUtcDays(start, 1) };
}

/**
 * Widen a range to whole UTC days.
 *
 * Rollup tables are keyed by day, so a job handed `09:00 -> 17:00` must still
 * process the entire day. Without this, a partial range would delete a whole
 * day's rows and rewrite them from a fraction of that day's events — a
 * data-losing "successful" run.
 */
export function snapToUtcDays(range: DateRange): DateRange {
  const { start, end } = normalizeRange(range);
  const snappedStart = startOfUtcDay(start);
  const snappedEnd =
    end.getTime() === startOfUtcDay(end).getTime() ? end : addUtcDays(startOfUtcDay(end), 1);
  return { start: snappedStart, end: snappedEnd < snappedStart ? snappedStart : snappedEnd };
}

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

/** The start of the bucket containing `value` at the given granularity. */
export function bucketStart(value: Date, granularity: Granularity): Date {
  if (granularity === 'month') return startOfUtcMonth(value);
  if (granularity === 'week') return startOfUtcWeek(value);
  return startOfUtcDay(value);
}

/** The start of the bucket after the one beginning at `start`. */
export function nextBucketStart(start: Date, granularity: Granularity): Date {
  if (granularity === 'month') return addUtcMonths(start, 1);
  if (granularity === 'week') return addUtcDays(start, 7);
  return addUtcDays(start, 1);
}

/**
 * The sortable key of the bucket containing `value`.
 *
 * Day and week buckets key on the `YYYY-MM-DD` of the bucket's first day;
 * month buckets key on `YYYY-MM`. Both sort lexicographically into
 * chronological order.
 */
export function bucketKeyOf(value: Date, granularity: Granularity): string {
  const start = bucketStart(value, granularity);
  return granularity === 'month' ? monthKey(start) : dayKey(start);
}

/** Short axis label for a bucket start. */
export function labelFor(start: Date, granularity: Granularity): string {
  const month = MONTH_LABELS[start.getUTCMonth()] ?? '';
  if (granularity === 'month') return `${month} ${start.getUTCFullYear()}`;
  return `${month} ${start.getUTCDate()}`;
}

/**
 * Every bucket touching a range, in chronological order.
 *
 * The first and last buckets may extend beyond the requested range — a month
 * bucket for a range starting on the 15th still begins on the 1st. Rows are
 * filtered to the range before they are counted, so those edge buckets are
 * genuinely partial. That is intrinsic to bucketing a partial period; the
 * bucket's `start`/`end` state the real span so a chart can annotate it.
 *
 * Returns `[]` for an empty or reversed range.
 */
export function buildBuckets(range: DateRange, granularity: Granularity): TimeBucket[] {
  const { start, end } = normalizeRange(range);
  if (end <= start) return [];

  const buckets: TimeBucket[] = [];
  let cursor = bucketStart(start, granularity);
  while (cursor < end && buckets.length < MAX_BUCKETS) {
    const next = nextBucketStart(cursor, granularity);
    buckets.push({
      key: granularity === 'month' ? monthKey(cursor) : dayKey(cursor),
      label: labelFor(cursor, granularity),
      start: cursor,
      end: next,
    });
    cursor = next;
  }
  return buckets;
}

/** Bucket key -> position, for O(1) assignment of a row to its column. */
export function bucketIndex(buckets: TimeBucket[]): Map<string, number> {
  const index = new Map<string, number>();
  buckets.forEach((bucket, position) => index.set(bucket.key, position));
  return index;
}

/**
 * Lay rows onto a zero-filled series.
 *
 * `seed` builds an empty point for each bucket, `apply` folds one row into the
 * point it belongs to. Rows outside the range, and rows whose date is null or
 * invalid, are skipped. Because the series is seeded from `buildBuckets`, a
 * user with no data gets a full zeroed series rather than an empty array —
 * which is the difference between a flat chart and a broken one.
 */
export function foldIntoBuckets<Row, Point>(
  rows: Row[],
  range: DateRange,
  granularity: Granularity,
  dateOf: (row: Row) => Date | null | undefined,
  seed: (bucket: TimeBucket) => Point,
  apply: (point: Point, row: Row) => void,
): Point[] {
  const buckets = buildBuckets(range, granularity);
  const points = buckets.map(seed);
  const index = bucketIndex(buckets);
  const normalized = normalizeRange(range);

  for (const row of rows) {
    const at = dateOf(row);
    if (!at || Number.isNaN(at.getTime())) continue;
    if (!isWithin(normalized, at)) continue;
    const position = index.get(bucketKeyOf(at, granularity));
    if (position === undefined) continue;
    const point = points[position];
    if (point === undefined) continue;
    apply(point, row);
  }

  return points;
}

/** The `SeriesPointBase` fields for a bucket, shared by every series type. */
export function seriesBase(bucket: TimeBucket): {
  bucket: string;
  label: string;
  start: string;
  end: string;
} {
  return {
    bucket: bucket.key,
    label: bucket.label,
    start: bucket.start.toISOString(),
    end: bucket.end.toISOString(),
  };
}

/** Whole hours between two instants, rounded, never negative. */
export function hoursBetween(from: Date, to: Date): number {
  const delta = to.getTime() - from.getTime();
  if (!Number.isFinite(delta) || delta <= 0) return 0;
  return Math.round(delta / (60 * 60 * 1000));
}
