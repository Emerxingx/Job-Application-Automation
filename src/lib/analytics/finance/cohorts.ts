import { db } from '@/lib/db';
import { addUtcMonths, dayKey, labelFor, monthKey, parseDayKey, startOfUtcMonth } from '../time';
import { rate, type RollupResult } from '../types';
import { MAX_COHORT_MONTHS, buildCohortGrid, type CohortGrid, type CohortSubscription } from './cohort-grid';

/**
 * Stage 21 (ADR-0036) - `SubscriptionCohortMart`: the retention grid the
 * revenue page draws, computed by the finance rollup from the subscriptions
 * (the only reader of that table for this purpose) and stored as one row per
 * (currency, cohort month, offset). The page reads rows; the grid shape is
 * rebuilt from them. Replace semantics per currency; the as-of `day` is the
 * run's day, because retention "so far" depends on when it was measured.
 */
export const COHORT_ROLLUP_JOB = 'subscription_cohorts';
export const COHORT_CURRENCIES = ['CAD', 'USD'] as const;

export interface CohortMartRow {
  currency: string;
  cohortMonth: string;
  monthOffset: number;
  subscribers: number;
  retained: number;
  day: string;
}

/** Pure: the grid → mart rows, per currency. */
export function cohortRowsOf(currency: string, grid: CohortGrid, asOfDay: string): CohortMartRow[] {
  const rows: CohortMartRow[] = [];
  for (const r of grid.rows) for (const c of r.cells) rows.push({ currency, cohortMonth: r.key, monthOffset: c.offset, subscribers: r.size, retained: c.retained, day: asOfDay });
  return rows;
}

/** Pure: mart rows → the grid shape the page draws (cohorts oldest first, only elapsed offsets, `parts` recomputed one way). */
export function gridFromRows(rows: CohortMartRow[], now: Date, months: number = MAX_COHORT_MONTHS): CohortGrid {
  const span = Math.max(1, Math.min(MAX_COHORT_MONTHS, Math.floor(months)));
  const thisMonth = startOfUtcMonth(now);
  const firstMonth = addUtcMonths(thisMonth, -(span - 1));
  const byCohort = new Map<string, CohortMartRow[]>();
  for (const r of rows) {
    const list = byCohort.get(r.cohortMonth) ?? [];
    list.push(r);
    byCohort.set(r.cohortMonth, list);
  }
  const out: CohortGrid = { rows: [], offsets: [], totalSubscriptions: 0 };
  let widest = 0;
  for (let index = 0; index < span; index += 1) {
    const cohortStart = addUtcMonths(firstMonth, index);
    const key = monthKey(cohortStart);
    const cells = (byCohort.get(key) ?? []).sort((a, b) => a.monthOffset - b.monthOffset);
    const size = cells[0]?.subscribers ?? 0;
    out.totalSubscriptions += size;
    widest = Math.max(widest, cells.length);
    out.rows.push({ key, label: labelFor(cohortStart, 'month'), size, cells: cells.map((c) => ({ offset: c.monthOffset, retained: c.retained, parts: rate(c.retained, c.subscribers).parts })) });
  }
  out.offsets = Array.from({ length: widest }, (_, offset) => offset);
  return out;
}

export interface CohortRollupDeps {
  loadSubscriptions(currency: string, since: Date): Promise<CohortSubscription[]>;
  replaceRows(currency: string, rows: CohortMartRow[]): Promise<number>;
  startRun?(job: string, range: { start: Date; end: Date }): Promise<string | null>;
  finishRun?(id: string | null, result: { status: 'succeeded' | 'failed'; rowsRead: number; rowsWritten: number; error?: string }): Promise<void>;
}

export const prismaCohortDeps: CohortRollupDeps = {
  async loadSubscriptions(currency, since) {
    return db.subscription.findMany({ where: { currency, startedAt: { gte: since } }, select: { startedAt: true, canceledAt: true, suspendedAt: true, status: true, currency: true } });
  },
  async replaceRows(currency, rows) {
    return db.$transaction(async (tx) => {
      await tx.subscriptionCohortMart.deleteMany({ where: { currency } });
      return rows.length ? (await tx.subscriptionCohortMart.createMany({ data: rows })).count : 0;
    });
  },
  async startRun(job, range) {
    return (await db.rollupRun.create({ data: { job, windowStart: range.start, windowEnd: range.end, status: 'running' }, select: { id: true } })).id;
  },
  async finishRun(id, result) {
    if (!id) return;
    await db.rollupRun.update({ where: { id }, data: { status: result.status, rowsRead: result.rowsRead, rowsWritten: result.rowsWritten, error: result.error ?? null, finishedAt: new Date() } });
  },
};

export async function rollupCohorts(options: { deps?: CohortRollupDeps; now?: Date } = {}): Promise<RollupResult> {
  const deps = options.deps ?? prismaCohortDeps;
  const now = options.now ?? new Date();
  const since = addUtcMonths(startOfUtcMonth(now), -(MAX_COHORT_MONTHS - 1));
  const range = { start: since, end: now };
  const runId = (await deps.startRun?.(COHORT_ROLLUP_JOB, range)) ?? null;
  try {
    let read = 0;
    let written = 0;
    for (const currency of COHORT_CURRENCIES) {
      const subs = await deps.loadSubscriptions(currency, since);
      read += subs.length;
      written += await deps.replaceRows(currency, cohortRowsOf(currency, buildCohortGrid(subs, now), dayKey(now)));
    }
    await deps.finishRun?.(runId, { status: 'succeeded', rowsRead: read, rowsWritten: written });
    return { job: COHORT_ROLLUP_JOB, windowStart: since.toISOString(), windowEnd: now.toISOString(), days: MAX_COHORT_MONTHS, rowsRead: read, rowsWritten: written, status: 'succeeded' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.finishRun?.(runId, { status: 'failed', rowsRead: 0, rowsWritten: 0, error: message });
    throw error;
  }
}

/** The revenue page's read: the mart for one currency, shaped as the grid. `asOf` is the day the rows were computed for (the page shows it). */
export async function readCohortGrid(currency: string, now: Date = new Date(), months: number = MAX_COHORT_MONTHS): Promise<CohortGrid & { asOf: Date | null }> {
  const rows = await db.subscriptionCohortMart.findMany({ where: { currency }, select: { currency: true, cohortMonth: true, monthOffset: true, subscribers: true, retained: true, day: true } });
  const asOf = rows[0] ? parseDayKey(rows[0].day) : null;
  return { ...gridFromRows(rows, now, months), asOf };
}
