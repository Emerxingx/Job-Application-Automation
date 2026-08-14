/**
 * The `from` / `to` window every export accepts.
 *
 * Boundaries are UTC and `to` is inclusive of the whole day. Both choices are
 * about what a person means: someone who types `to=2026-08-14` means "include
 * the 14th", not "stop at midnight on the 14th", and a report generated in
 * Toronto must contain the same rows when the same request is served from a
 * container running UTC.
 */

import { formatDateKey, type ExportFilter } from './dataset';

export interface ExportRange {
  /** Inclusive lower bound, or null for unbounded. */
  from: Date | null;
  /** Inclusive upper bound (end of that UTC day), or null for unbounded. */
  to: Date | null;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse one boundary.
 *
 * A bare `YYYY-MM-DD` is snapped to the start or the end of that UTC day
 * depending on which edge it is; a full ISO timestamp is taken as given.
 * Returns null for anything unparseable so the caller can reject it with a
 * message rather than silently exporting the wrong window.
 */
export function parseBoundary(value: string | undefined, edge: 'start' | 'end'): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (DATE_ONLY.test(trimmed)) {
    const [year, month, day] = trimmed.split('-').map(Number);
    // Date.UTC rejects nothing, so 2026-02-31 rolls into March. Compare the
    // round trip to catch it.
    const time =
      edge === 'start'
        ? Date.UTC(year, month - 1, day, 0, 0, 0, 0)
        : Date.UTC(year, month - 1, day, 23, 59, 59, 999);
    const date = new Date(time);
    if (formatDateKey(date) !== trimmed) return null;
    return date;
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export interface RangeInput {
  from?: string;
  to?: string;
}

/** Parse both boundaries. Absent means unbounded, not "today". */
export function parseExportRange(input: RangeInput): ExportRange {
  return {
    from: parseBoundary(input.from, 'start'),
    to: parseBoundary(input.to, 'end'),
  };
}

/**
 * Why this range is unusable, or null when it is fine.
 *
 * Returned as a message rather than thrown: the route turns it into a 422 with
 * the text in it, which is more useful to whoever wrote the query string than
 * a generic validation failure.
 */
export function rangeProblem(input: RangeInput, range: ExportRange): string | null {
  if (input.from && !range.from) {
    return `"from" is not a valid date. Use YYYY-MM-DD, for example ${formatDateKey(new Date())}.`;
  }
  if (input.to && !range.to) {
    return `"to" is not a valid date. Use YYYY-MM-DD, for example ${formatDateKey(new Date())}.`;
  }
  if (range.from && range.to && range.from > range.to) {
    return '"from" must be on or before "to".';
  }
  return null;
}

/** A Prisma date filter for the range, or undefined when unbounded. */
export function rangeFilter(range: ExportRange): { gte?: Date; lte?: Date } | undefined {
  if (!range.from && !range.to) return undefined;
  return {
    ...(range.from ? { gte: range.from } : {}),
    ...(range.to ? { lte: range.to } : {}),
  };
}

/** Whether an instant falls inside the range. Unbounded edges accept anything. */
export function withinRange(range: ExportRange, value: Date | null | undefined): boolean {
  if (!value) return false;
  if (range.from && value < range.from) return false;
  if (range.to && value > range.to) return false;
  return true;
}

/** Human phrasing for the PDF's filter line. */
export function describeRange(range: ExportRange): string {
  if (range.from && range.to) return `${formatDateKey(range.from)} to ${formatDateKey(range.to)}`;
  if (range.from) return `${formatDateKey(range.from)} onwards`;
  if (range.to) return `up to ${formatDateKey(range.to)}`;
  return 'All time';
}

/**
 * The filename fragment.
 *
 * Always contains dates, including when the range is unbounded — a folder of
 * `applications.csv`, `applications (1).csv`, `applications (2).csv` tells the
 * person who downloaded them nothing, and "all-time as of the 14th" is a real
 * distinction from "all-time as of the 20th".
 */
export function rangeSlug(range: ExportRange, now: Date = new Date()): string {
  if (range.from && range.to) return `${formatDateKey(range.from)}_to_${formatDateKey(range.to)}`;
  if (range.from) return `from_${formatDateKey(range.from)}_to_${formatDateKey(now)}`;
  if (range.to) return `until_${formatDateKey(range.to)}`;
  return `all-time_to_${formatDateKey(now)}`;
}

/** The range as a filter row for the report header. */
export function rangeFilters(range: ExportRange): ExportFilter[] {
  return [{ label: 'Date range', value: describeRange(range) }];
}

export const UNBOUNDED_RANGE: ExportRange = { from: null, to: null };
