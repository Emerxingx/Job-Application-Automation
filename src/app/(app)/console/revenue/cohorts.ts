/**
 * Cohort retention: of the subscriptions that started in month M, how many
 * were still subscribed in month M+k.
 *
 * WHY THIS IS COMPUTABLE AT ALL. `Subscription.userId` is unique, so a customer
 * has exactly one subscription row and a cohort cannot double-count anybody.
 * That makes retention answerable from the live table — no event replay, no
 * nightly job — and it is why this is a logo-retention grid rather than a
 * revenue-retention one. Revenue retention needs the MRR at each historical
 * instant, which lives in `SubscriptionEvent`, and `computeChurn` in
 * lib/analytics/revenue.ts already reports that as net revenue retention for
 * the selected window.
 *
 * WHAT "STILL SUBSCRIBED" MEANS. A subscription is counted as alive in month
 * M+k when it had not ended before that month began. It ends at `canceledAt`,
 * or at `suspendedAt` when dunning suspended it without a cancellation. A row
 * whose status says it is finished but which carries neither date is treated as
 * alive until now — an unknown end date must not be back-dated onto a cohort it
 * would silently shrink.
 *
 * The computation is pure and takes `now` as an argument, so every boundary in
 * it is directly testable.
 */

import { db } from '@/lib/db';
import { addUtcMonths, labelFor, monthKey, startOfUtcMonth } from '@/lib/analytics/time';
import { rate } from '@/lib/analytics/types';

/** Widest grid that stays readable on a laptop, and a year is the usual ask. */
export const MAX_COHORT_MONTHS = 12;

export interface CohortSubscription {
  startedAt: Date;
  canceledAt: Date | null;
  suspendedAt: Date | null;
  status: string;
  currency: string;
}

export interface CohortCell {
  /** Months after the cohort's first month. 0 is the month they joined. */
  offset: number;
  retained: number;
  /** Share of the cohort still subscribed, parts per million. */
  parts: number;
}

export interface CohortRow {
  /** `YYYY-MM`. */
  key: string;
  label: string;
  size: number;
  /** One cell per elapsed month, oldest first. Never longer than the grid. */
  cells: CohortCell[];
}

export interface CohortGrid {
  rows: CohortRow[];
  /** Column headings: `M0`, `M1`, … as wide as the widest row. */
  offsets: number[];
  /** Cohort members across the whole grid — the denominator of the summary. */
  totalSubscriptions: number;
}

/** Statuses that mean the subscription is over. */
const ENDED_STATUSES = new Set(['canceled', 'suspended']);

/**
 * When a subscription stopped, or null while it is still running.
 *
 * `canceledAt` wins over `suspendedAt` when both are set: a suspension that
 * later became a cancellation ended on the day access actually stopped, which
 * is the suspension — so the EARLIER of the two is the honest answer.
 */
export function endedAt(subscription: CohortSubscription): Date | null {
  const dates = [subscription.canceledAt, subscription.suspendedAt].filter(
    (value): value is Date => value instanceof Date,
  );
  if (dates.length === 0) return null;
  return dates.reduce((earliest, value) => (value < earliest ? value : earliest));
}

/** Whether the subscription was still running when `instant` arrived. */
export function aliveAt(subscription: CohortSubscription, instant: Date): boolean {
  const ended = endedAt(subscription);
  if (ended) return ended >= instant;
  // No end date. Only an ENDED status contradicts that, and with no date to
  // place it we treat it as ending now rather than inventing a past one.
  return !ENDED_STATUSES.has(subscription.status);
}

/**
 * Build the grid.
 *
 * Cohorts run oldest first so the triangle reads top-left to bottom-right, the
 * shape every retention grid uses. Only elapsed months get a cell: a cohort
 * that started last month has no month-3 number, and printing 0% there would
 * read as total churn rather than as "not yet".
 */
export function buildCohortGrid(
  subscriptions: CohortSubscription[],
  now: Date = new Date(),
  months: number = MAX_COHORT_MONTHS,
): CohortGrid {
  const span = Math.max(1, Math.min(MAX_COHORT_MONTHS, Math.floor(months)));
  const thisMonth = startOfUtcMonth(now);
  const firstMonth = addUtcMonths(thisMonth, -(span - 1));

  const buckets = new Map<string, CohortSubscription[]>();
  for (const subscription of subscriptions) {
    if (subscription.startedAt < firstMonth) continue;
    if (subscription.startedAt >= addUtcMonths(thisMonth, 1)) continue;
    const key = monthKey(startOfUtcMonth(subscription.startedAt));
    const bucket = buckets.get(key);
    if (bucket) bucket.push(subscription);
    else buckets.set(key, [subscription]);
  }

  const rows: CohortRow[] = [];
  let totalSubscriptions = 0;
  let widest = 0;

  for (let index = 0; index < span; index += 1) {
    const cohortStart = addUtcMonths(firstMonth, index);
    const key = monthKey(cohortStart);
    const members = buckets.get(key) ?? [];
    totalSubscriptions += members.length;

    const cells: CohortCell[] = [];
    // Month 0 is the month they joined; the last column is the current month.
    for (let offset = 0; offset < span - index; offset += 1) {
      const monthStart = addUtcMonths(cohortStart, offset);
      if (monthStart > thisMonth) break;
      // Offset 0 is measured at the cohort month's start, which every member
      // of the cohort is by definition alive for — so it is always 100%, and
      // it is kept because a grid without its baseline column is harder to read.
      const instant = offset === 0 ? cohortStart : monthStart;
      const retained = members.filter((member) => aliveAt(member, instant)).length;
      cells.push({ offset, retained, parts: rate(retained, members.length).parts });
    }

    widest = Math.max(widest, cells.length);
    rows.push({
      key,
      label: labelFor(cohortStart, 'month'),
      size: members.length,
      cells,
    });
  }

  return {
    rows,
    offsets: Array.from({ length: widest }, (_, offset) => offset),
    totalSubscriptions,
  };
}

/**
 * Load the cohort grid for one currency.
 *
 * Scoped to a currency so the page stays coherent with the money above it, not
 * because retention is a currency-denominated idea — a CAD reader looking at a
 * grid that silently included US subscribers would draw the wrong conclusion
 * about the numbers beside it.
 */
export async function loadCohortGrid(
  currency: string,
  now: Date = new Date(),
  months: number = MAX_COHORT_MONTHS,
): Promise<CohortGrid> {
  const since = addUtcMonths(startOfUtcMonth(now), -(Math.max(1, months) - 1));

  const subscriptions = await db.subscription.findMany({
    where: { currency, startedAt: { gte: since } },
    select: {
      startedAt: true,
      canceledAt: true,
      suspendedAt: true,
      status: true,
      currency: true,
    },
  });

  return buildCohortGrid(subscriptions, now, months);
}
