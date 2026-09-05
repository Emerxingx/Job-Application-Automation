// Daily rollups: turn append-only raw events into the pre-aggregated rows the
// dashboards actually read.
//
// WHY IDEMPOTENCY IS STRUCTURAL, NOT CAREFUL
//
// Every writer here RECOMPUTES a whole day from the raw events and REPLACES
// the rows for that day. Nothing increments. That is the difference between
// "running the backfill twice is safe" as a property of the code and as a
// promise someone made once in a comment: an incrementing writer double-counts
// the moment a cron fires twice, a deploy retries, or an operator re-runs
// yesterday to fix a gap. A replacing writer cannot, no matter how many times
// it runs or how it is interleaved.
//
// The scope of the replace is `(days x metrics)` — and `userId` too when the
// job was scoped to one user. Without that last part, a single-user backfill
// would delete every other user's rows for those days.
//
// I/O IS INJECTED. Each job takes a `deps` object holding its reads and its
// writes. The default is Prisma; a test passes an in-memory implementation and
// proves idempotency without a database.

import { db } from '@/lib/db';
import { BASE_CURRENCY, rate } from './types';
import type {
  DailyMetricRow,
  DailyRevenueRow,
  DateRange,
  DunningAttemptRow,
  InvoiceRow,
  PaymentRow,
  RollupResult,
  SubscriptionEventRow,
  SubscriptionRow,
  UsageEventRow,
  UsageRollupRow,
} from './types';
import { addUtcDays, dayKey, dayRange, eachDayKey, normalizeRange, snapToUtcDays } from './time';
import {
  BILLED_INVOICE_STATUSES,
  computeDunningRecovery,
  computeMovement,
  computeMrrSnapshot,
  invoiceDate,
  isSettledPayment,
  loadDunningAttemptRows,
  loadInvoiceRows,
  loadPaymentRows,
  loadSubscriptionEventRows,
  loadSubscriptionRows,
  mrrAtInstant,
  paymentDate,
} from './revenue';

// ---------------------------------------------------------------------------
// Metric vocabularies
// ---------------------------------------------------------------------------

/**
 * `UsageEvent.name` -> `DailyUsageRollup.metric`.
 *
 * An event whose name is not in this map is counted as read but produces no
 * rollup row. That is deliberate: a new event type should show up in the raw
 * table immediately and appear on a dashboard only once someone has decided
 * what it means.
 */
export const USAGE_METRIC_BY_EVENT: Readonly<Record<string, string>> = {
  'application.submitted': 'applications_submitted',
  'application.responded': 'responses',
  'application.interview': 'interviews',
  'application.offer': 'offers',
  'job.scanned': 'jobs_scanned',
  'resume.tailored': 'resumes_tailored',
  'ai.tokens': 'ai_tokens',
  'api.request': 'api_requests',
  login: 'logins',
};

/** Every metric this job owns — and therefore every metric it may delete. */
export const MANAGED_USAGE_METRICS: readonly string[] = [
  ...new Set(Object.values(USAGE_METRIC_BY_EVENT)),
];

/** Platform metrics written to `DailyMetric` by `rollupPlatformMetrics`. */
export const MANAGED_PLATFORM_METRICS: readonly string[] = [
  'signups',
  'applications_submitted',
  'active_users',
];

/** PostgreSQL caps bind parameters at 65535 per statement; chunk inserts well under it. */
const INSERT_CHUNK = 100;

// ---------------------------------------------------------------------------
// Pure aggregation
// ---------------------------------------------------------------------------

/**
 * Fold raw usage events into `(day, userId, metric)` rows.
 *
 * Events with a null `userId` are skipped: `DailyUsageRollup.userId` is a
 * required foreign key, and anonymous activity belongs in `DailyMetric`
 * instead. Events outside the range, and events whose name has no mapping, are
 * skipped too.
 *
 * Output is sorted by day, then user, then metric — a deterministic order, so
 * two runs over the same input produce byte-identical output and a diff means
 * the data changed rather than the iteration order.
 */
export function aggregateUsageEvents(
  events: UsageEventRow[],
  options?: { range?: DateRange },
): UsageRollupRow[] {
  const window = options?.range ? normalizeRange(options.range) : null;
  const rows = new Map<string, UsageRollupRow>();

  for (const event of events) {
    if (!event.userId) continue;
    if (!event.occurredAt || Number.isNaN(event.occurredAt.getTime())) continue;
    if (window && (event.occurredAt < window.start || event.occurredAt >= window.end)) continue;

    const metric = USAGE_METRIC_BY_EVENT[event.name];
    if (!metric) continue;

    const day = dayKey(event.occurredAt);
    const key = `${day}|${event.userId}|${metric}`;
    const row = rows.get(key) ?? { day, userId: event.userId, metric, count: 0, valueCents: 0 };
    row.count += Number.isFinite(event.quantity) ? event.quantity : 0;
    row.valueCents += Number.isFinite(event.valueCents) ? event.valueCents : 0;
    rows.set(key, row);
  }

  return [...rows.values()].sort(
    (a, b) =>
      compare(a.day, b.day) || compare(a.userId, b.userId) || compare(a.metric, b.metric),
  );
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Platform-wide daily counts for `DailyMetric`.
 *
 * `active_users` counts DISTINCT users with any usage event that day, which is
 * why it cannot be summed out of `DailyUsageRollup` after the fact — summing
 * per-user rows would count a user once per metric they touched.
 */
export function computeDailyMetricRows(
  input: {
    signups: Date[];
    submissions: Date[];
    activity: { userId: string | null; occurredAt: Date }[];
  },
  range: DateRange,
): DailyMetricRow[] {
  const days = eachDayKey(range);
  const signups = new Map<string, number>();
  const submissions = new Map<string, number>();
  const actives = new Map<string, Set<string>>();

  for (const at of input.signups) {
    const day = dayKey(at);
    signups.set(day, (signups.get(day) ?? 0) + 1);
  }
  for (const at of input.submissions) {
    const day = dayKey(at);
    submissions.set(day, (submissions.get(day) ?? 0) + 1);
  }
  for (const event of input.activity) {
    if (!event.userId) continue;
    const day = dayKey(event.occurredAt);
    const set = actives.get(day) ?? new Set<string>();
    set.add(event.userId);
    actives.set(day, set);
  }

  const rows: DailyMetricRow[] = [];
  for (const day of days) {
    rows.push(metricRow(day, 'signups', signups.get(day) ?? 0));
    rows.push(metricRow(day, 'applications_submitted', submissions.get(day) ?? 0));
    rows.push(metricRow(day, 'active_users', actives.get(day)?.size ?? 0));
  }
  return rows;
}

function metricRow(day: string, metric: string, valueInt: number): DailyMetricRow {
  return { day, metric, dimension: 'all', valueInt, valueCents: 0, valueParts: 0 };
}

/**
 * Build the wide `DailyRevenueRollup` rows for a range.
 *
 * CURRENCY SPLIT, stated plainly because the schema cannot state it:
 * cash columns (invoiced/paid/refunded/fees) are per-currency and only ever
 * hold rows of that currency. MRR columns are normalised to the CAD base by
 * `SubscriptionEvent`, which carries no currency of its own — so they are
 * written ONLY on the base-currency row, and a USD row carries zeros for them.
 * The alternative, repeating base MRR on every currency row, would double it
 * the moment anyone summed across currencies.
 *
 * `events` must span the full history up to the end of the range: each day's
 * MRR is reconstructed from the last event at or before that day's end.
 */
export function computeDailyRevenueRows(
  input: {
    invoices: InvoiceRow[];
    payments: PaymentRow[];
    events: SubscriptionEventRow[];
    dunningAttempts?: DunningAttemptRow[];
    subscriptions?: SubscriptionRow[];
  },
  range: DateRange,
): DailyRevenueRow[] {
  const days = eachDayKey(range);
  const dunningAttempts = input.dunningAttempts ?? [];

  const currencies = new Set<string>([BASE_CURRENCY]);
  for (const invoice of input.invoices) currencies.add(invoice.currency);
  for (const payment of input.payments) currencies.add(payment.currency);

  const rows: DailyRevenueRow[] = [];
  const sortedCurrencies = [...currencies].sort(compare);

  // Index the source rows by (day, currency) once. Rescanning every invoice
  // and payment for every day of a year-long backfill is the difference
  // between a job that finishes and one that gets killed.
  const byDayCurrency = new Map<string, DailyRevenueRow>();
  for (const day of days) {
    for (const currency of sortedCurrencies) {
      byDayCurrency.set(`${day}|${currency}`, emptyRevenueRow(day, currency));
    }
  }

  for (const invoice of input.invoices) {
    if (!BILLED_INVOICE_STATUSES.includes(invoice.status)) continue;
    const row = byDayCurrency.get(`${dayKey(invoiceDate(invoice))}|${invoice.currency}`);
    if (!row) continue;
    row.invoicesBilled += 1;
    row.invoicedCents += invoice.totalCents;
    row.discountCents += invoice.discountCents;
    row.taxCents += invoice.taxCents;
    row.creditedCents += invoice.amountCreditedCents;
  }

  for (const payment of input.payments) {
    const row = byDayCurrency.get(`${dayKey(paymentDate(payment))}|${payment.currency}`);
    if (!row) continue;
    // Stage 21: every payment is counted by outcome (payment health reads the
    // mart); only a SETTLED one moves cash.
    if (isSettledPayment(payment.status)) row.paymentsSucceeded += 1;
    else if (payment.status === 'failed') {
      row.paymentsFailed += 1;
      row.failedPaymentCents += payment.amountCents;
    }
    else if (payment.status === 'pending' || payment.status === 'requires_action') row.paymentsPending += 1;
    if (!isSettledPayment(payment.status)) continue;
    row.paidCents += payment.amountCents;
    row.refundedCents += payment.amountRefundedCents;
    row.feeCents += payment.feeCents;
  }

  // Yesterday's closing MRR is today's opening MRR, so the event log is walked
  // once per day boundary rather than twice.
  let opening = mrrAtInstant(input.events, dayRange(days[0] ?? dayKey(range.start)).start);

  for (const day of days) {
    const window = dayRange(day);
    const closing = mrrAtInstant(input.events, window.end);
    const movement = computeMovement(input.events, window);

    for (const currency of sortedCurrencies) {
      const row = byDayCurrency.get(`${day}|${currency}`);
      if (!row) continue;

      row.netCents = row.paidCents - row.refundedCents - row.feeCents;
      row.dunningRecoveryParts = computeDunningRecovery(dunningAttempts, window).parts;

      if (currency === BASE_CURRENCY) {
        row.mrrCents = closing.mrrCents;
        row.arrCents = closing.mrrCents * 12;
        row.newMrrCents = movement.newMrrCents;
        row.expansionMrrCents = movement.expansionMrrCents;
        row.contractionMrrCents = movement.contractionMrrCents;
        row.churnedMrrCents = movement.churnedMrrCents;
        row.reactivationMrrCents = movement.reactivationMrrCents;

        // Subscription.userId is unique, so a paying subscription and a paying
        // customer are the same thing here.
        row.activeSubscriptions = closing.subscriptions;
        row.payingCustomers = closing.subscriptions;
        row.newCustomers = movement.newSubscribers;
        row.churnedCustomers = movement.churnedSubscribers;
        row.reactivatedCustomers = movement.reactivatedSubscribers;
        row.arpuCents =
          closing.subscriptions > 0 ? Math.round(closing.mrrCents / closing.subscriptions) : 0;

        const grossLost = movement.churnedMrrCents + movement.contractionMrrCents;
        const grossGained = movement.expansionMrrCents + movement.reactivationMrrCents;
        row.logoChurnParts = rate(movement.churnedSubscribers, opening.subscriptions).parts;
        row.grossMrrChurnParts = rate(grossLost, opening.mrrCents).parts;
        row.netRevenueRetentionParts = rate(
          opening.mrrCents + grossGained - grossLost,
          opening.mrrCents,
        ).parts;

        // Live statuses are a snapshot of *now*, so they only describe the
        // current day. Backfilled days leave them at zero rather than stamping
        // today's counts onto last month.
        const isToday = day === dayKey(new Date());
        if (isToday && input.subscriptions) {
          const snapshot = computeMrrSnapshot(input.subscriptions, BASE_CURRENCY);
          row.trialingSubscriptions = snapshot.trialingSubscribers;
          row.pastDueSubscriptions = snapshot.pastDueSubscribers;
          row.canceledSubscriptions = snapshot.canceledSubscribers;
        }
      }

      rows.push(row);
    }

    opening = closing;
  }

  return rows;
}

function emptyRevenueRow(day: string, currency: string): DailyRevenueRow {
  return {
    day,
    currency,
    invoicedCents: 0,
    discountCents: 0,
    taxCents: 0,
    paidCents: 0,
    refundedCents: 0,
    creditedCents: 0,
    feeCents: 0,
    netCents: 0,
    mrrCents: 0,
    arrCents: 0,
    newMrrCents: 0,
    expansionMrrCents: 0,
    contractionMrrCents: 0,
    churnedMrrCents: 0,
    reactivationMrrCents: 0,
    arpuCents: 0,
    activeSubscriptions: 0,
    trialingSubscriptions: 0,
    pastDueSubscriptions: 0,
    canceledSubscriptions: 0,
    payingCustomers: 0,
    newCustomers: 0,
    churnedCustomers: 0,
    logoChurnParts: 0,
    grossMrrChurnParts: 0,
    netRevenueRetentionParts: 0,
    dunningRecoveryParts: 0,
    invoicesBilled: 0,
    paymentsSucceeded: 0,
    paymentsFailed: 0,
    paymentsPending: 0,
    failedPaymentCents: 0,
    reactivatedCustomers: 0,
  };
}

// ---------------------------------------------------------------------------
// Injected I/O
// ---------------------------------------------------------------------------

/** Scope of a replace. Everything matching is deleted before the rewrite. */
export interface ReplaceScope {
  days: string[];
  metrics: string[];
  /** Present only when the job was scoped to one user. */
  userId?: string;
}

export interface UsageRollupDeps {
  loadUsageEvents(range: DateRange, userId?: string): Promise<UsageEventRow[]>;
  /** Delete everything in scope, then write `rows`. Returns rows written. */
  replaceUsageRollups(scope: ReplaceScope, rows: UsageRollupRow[]): Promise<number>;
  startRun?(job: string, range: DateRange): Promise<string | null>;
  finishRun?(
    id: string | null,
    result: { status: 'succeeded' | 'failed'; rowsRead: number; rowsWritten: number; error?: string },
  ): Promise<void>;
}

export interface RevenueRollupDeps {
  loadInvoices(range: DateRange): Promise<InvoiceRow[]>;
  loadPayments(range: DateRange): Promise<PaymentRow[]>;
  loadSubscriptionEvents(until: Date): Promise<SubscriptionEventRow[]>;
  loadDunningAttempts(range: DateRange): Promise<DunningAttemptRow[]>;
  loadSubscriptions(): Promise<SubscriptionRow[]>;
  replaceRevenueRollups(days: string[], rows: DailyRevenueRow[]): Promise<number>;
  startRun?(job: string, range: DateRange): Promise<string | null>;
  finishRun?(
    id: string | null,
    result: { status: 'succeeded' | 'failed'; rowsRead: number; rowsWritten: number; error?: string },
  ): Promise<void>;
}

export interface PlatformRollupDeps {
  loadSignups(range: DateRange): Promise<Date[]>;
  loadSubmissions(range: DateRange): Promise<Date[]>;
  loadActivity(range: DateRange): Promise<{ userId: string | null; occurredAt: Date }[]>;
  replaceDailyMetrics(scope: ReplaceScope, rows: DailyMetricRow[]): Promise<number>;
  startRun?(job: string, range: DateRange): Promise<string | null>;
  finishRun?(
    id: string | null,
    result: { status: 'succeeded' | 'failed'; rowsRead: number; rowsWritten: number; error?: string },
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Prisma implementations
// ---------------------------------------------------------------------------

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function startPrismaRun(job: string, range: DateRange): Promise<string | null> {
  const run = await db.rollupRun.create({
    data: { job, windowStart: range.start, windowEnd: range.end, status: 'running' },
    select: { id: true },
  });
  return run.id;
}

async function finishPrismaRun(
  id: string | null,
  result: { status: 'succeeded' | 'failed'; rowsRead: number; rowsWritten: number; error?: string },
): Promise<void> {
  if (!id) return;
  await db.rollupRun.update({
    where: { id },
    data: {
      status: result.status,
      rowsRead: result.rowsRead,
      rowsWritten: result.rowsWritten,
      error: result.error ?? null,
      finishedAt: new Date(),
    },
  });
}

export const prismaUsageRollupDeps: UsageRollupDeps = {
  async loadUsageEvents(range, userId) {
    const window = normalizeRange(range);
    return db.usageEvent.findMany({
      where: {
        occurredAt: { gte: window.start, lt: window.end },
        ...(userId ? { userId } : {}),
      },
      select: { userId: true, name: true, quantity: true, valueCents: true, occurredAt: true },
      orderBy: { occurredAt: 'asc' },
    });
  },

  async replaceUsageRollups(scope, rows) {
    if (scope.days.length === 0) return 0;
    return db.$transaction(async (tx) => {
      await tx.dailyUsageRollup.deleteMany({
        where: {
          day: { in: scope.days },
          metric: { in: [...scope.metrics] },
          ...(scope.userId ? { userId: scope.userId } : {}),
        },
      });
      let written = 0;
      for (const batch of chunk(rows, INSERT_CHUNK)) {
        const created = await tx.dailyUsageRollup.createMany({ data: batch });
        written += created.count;
      }
      return written;
    });
  },

  startRun: startPrismaRun,
  finishRun: finishPrismaRun,
};

export const prismaRevenueRollupDeps: RevenueRollupDeps = {
  loadInvoices: (range) => loadInvoiceRows(range),
  loadPayments: (range) => loadPaymentRows(range),
  loadSubscriptionEvents: (until) => loadSubscriptionEventRows(until),
  loadDunningAttempts: (range) => loadDunningAttemptRows(range),
  loadSubscriptions: () => loadSubscriptionRows(),

  async replaceRevenueRollups(days, rows) {
    if (days.length === 0) return 0;
    return db.$transaction(async (tx) => {
      await tx.dailyRevenueRollup.deleteMany({ where: { day: { in: days } } });
      let written = 0;
      for (const batch of chunk(rows, 20)) {
        const created = await tx.dailyRevenueRollup.createMany({ data: batch });
        written += created.count;
      }
      return written;
    });
  },

  startRun: startPrismaRun,
  finishRun: finishPrismaRun,
};

export const prismaPlatformRollupDeps: PlatformRollupDeps = {
  async loadSignups(range) {
    const window = normalizeRange(range);
    const rows = await db.user.findMany({
      where: { createdAt: { gte: window.start, lt: window.end } },
      select: { createdAt: true },
    });
    return rows.map((row) => row.createdAt);
  },

  async loadSubmissions(range) {
    const window = normalizeRange(range);
    const rows = await db.application.findMany({
      where: { appliedAt: { gte: window.start, lt: window.end } },
      select: { appliedAt: true },
    });
    return rows.flatMap((row) => (row.appliedAt ? [row.appliedAt] : []));
  },

  async loadActivity(range) {
    const window = normalizeRange(range);
    return db.usageEvent.findMany({
      where: { occurredAt: { gte: window.start, lt: window.end }, userId: { not: null } },
      select: { userId: true, occurredAt: true },
    });
  },

  async replaceDailyMetrics(scope, rows) {
    if (scope.days.length === 0) return 0;
    return db.$transaction(async (tx) => {
      await tx.dailyMetric.deleteMany({
        where: { day: { in: scope.days }, metric: { in: [...scope.metrics] } },
      });
      let written = 0;
      for (const batch of chunk(rows, INSERT_CHUNK)) {
        const created = await tx.dailyMetric.createMany({ data: batch });
        written += created.count;
      }
      return written;
    });
  },

  startRun: startPrismaRun,
  finishRun: finishPrismaRun,
};

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

function result(
  job: string,
  range: DateRange,
  days: number,
  rowsRead: number,
  rowsWritten: number,
  status: 'succeeded' | 'failed' = 'succeeded',
  error?: string,
): RollupResult {
  return {
    job,
    windowStart: range.start.toISOString(),
    windowEnd: range.end.toISOString(),
    days,
    rowsRead,
    rowsWritten,
    status,
    ...(error ? { error } : {}),
  };
}

/**
 * Recompute `DailyUsageRollup` for a range.
 *
 * Safe to run any number of times over any range: the rows for the days in
 * scope are deleted and rewritten from the raw events, so the result depends
 * only on the events, never on how often the job ran.
 *
 * A day whose events have all been pruned correctly ends with no rows — which
 * is why the delete is not conditional on the recomputed set being non-empty.
 */
export async function rollupUsage(
  range: DateRange,
  options?: { userId?: string; deps?: UsageRollupDeps },
): Promise<RollupResult> {
  // Snapped to whole UTC days: the table's grain is a day, so a partial range
  // must widen rather than rewrite a day from a fraction of its events.
  const window = snapToUtcDays(range);
  const deps = options?.deps ?? prismaUsageRollupDeps;
  const days = eachDayKey(window);
  const runId = (await deps.startRun?.('daily_usage', window)) ?? null;

  try {
    const events = await deps.loadUsageEvents(window, options?.userId);
    const rows = aggregateUsageEvents(events, { range: window });
    const written = await deps.replaceUsageRollups(
      {
        days,
        metrics: [...MANAGED_USAGE_METRICS],
        ...(options?.userId ? { userId: options.userId } : {}),
      },
      rows,
    );

    await deps.finishRun?.(runId, {
      status: 'succeeded',
      rowsRead: events.length,
      rowsWritten: written,
    });
    return result('daily_usage', window, days.length, events.length, written);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.finishRun?.(runId, {
      status: 'failed',
      rowsRead: 0,
      rowsWritten: 0,
      error: message,
    });
    throw error;
  }
}

/** Yesterday's usage rollup — the shape a nightly cron calls. */
export async function rollupUsageForDay(
  day: Date,
  options?: { userId?: string; deps?: UsageRollupDeps },
): Promise<RollupResult> {
  return rollupUsage(dayRange(dayKey(day)), options);
}

/**
 * Recompute a long range in chunks.
 *
 * Chunking bounds memory: a year of raw events for every user does not fit
 * comfortably in one array, and a chunk that fails leaves the chunks before it
 * correctly written — re-running the whole range then simply redoes them,
 * because each chunk is itself a replace.
 */
export async function backfillUsageRollups(
  range: DateRange,
  options?: { userId?: string; deps?: UsageRollupDeps; chunkDays?: number },
): Promise<RollupResult> {
  const window = snapToUtcDays(range);
  const chunkDays = Math.max(1, options?.chunkDays ?? 7);
  const days = eachDayKey(window);
  if (days.length === 0) return result('daily_usage_backfill', window, 0, 0, 0);

  let rowsRead = 0;
  let rowsWritten = 0;

  let cursor = window.start;
  while (cursor < window.end) {
    const next = addUtcDays(cursor, chunkDays);
    const slice = { start: cursor, end: next > window.end ? window.end : next };
    const partial = await rollupUsage(slice, { userId: options?.userId, deps: options?.deps });
    rowsRead += partial.rowsRead;
    rowsWritten += partial.rowsWritten;
    cursor = next;
  }

  return result('daily_usage_backfill', window, days.length, rowsRead, rowsWritten);
}

/** Recompute `DailyRevenueRollup` for a range. Same replace semantics. */
export async function rollupRevenue(
  range: DateRange,
  options?: { deps?: RevenueRollupDeps },
): Promise<RollupResult> {
  const window = snapToUtcDays(range);
  const deps = options?.deps ?? prismaRevenueRollupDeps;
  const days = eachDayKey(window);
  const runId = (await deps.startRun?.('daily_revenue', window)) ?? null;

  try {
    const [invoices, payments, events, dunningAttempts, subscriptions] = await Promise.all([
      deps.loadInvoices(window),
      deps.loadPayments(window),
      deps.loadSubscriptionEvents(window.end),
      deps.loadDunningAttempts(window),
      deps.loadSubscriptions(),
    ]);

    const rows = computeDailyRevenueRows(
      { invoices, payments, events, dunningAttempts, subscriptions },
      window,
    );
    const written = await deps.replaceRevenueRollups(days, rows);
    const rowsRead = invoices.length + payments.length + events.length + dunningAttempts.length;

    await deps.finishRun?.(runId, { status: 'succeeded', rowsRead, rowsWritten: written });
    return result('daily_revenue', window, days.length, rowsRead, written);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.finishRun?.(runId, {
      status: 'failed',
      rowsRead: 0,
      rowsWritten: 0,
      error: message,
    });
    throw error;
  }
}

/** Recompute `DailyMetric` for a range. Same replace semantics. */
export async function rollupPlatformMetrics(
  range: DateRange,
  options?: { deps?: PlatformRollupDeps },
): Promise<RollupResult> {
  const window = snapToUtcDays(range);
  const deps = options?.deps ?? prismaPlatformRollupDeps;
  const days = eachDayKey(window);
  const runId = (await deps.startRun?.('daily_metrics', window)) ?? null;

  try {
    const [signups, submissions, activity] = await Promise.all([
      deps.loadSignups(window),
      deps.loadSubmissions(window),
      deps.loadActivity(window),
    ]);

    const rows = computeDailyMetricRows({ signups, submissions, activity }, window);
    const written = await deps.replaceDailyMetrics(
      { days, metrics: [...MANAGED_PLATFORM_METRICS] },
      rows,
    );
    const rowsRead = signups.length + submissions.length + activity.length;

    await deps.finishRun?.(runId, { status: 'succeeded', rowsRead, rowsWritten: written });
    return result('daily_metrics', window, days.length, rowsRead, written);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.finishRun?.(runId, {
      status: 'failed',
      rowsRead: 0,
      rowsWritten: 0,
      error: message,
    });
    throw error;
  }
}

/**
 * Every rollup for a range, usage first.
 *
 * Failures are collected rather than thrown so one broken job does not leave
 * the others unrun — a nightly cron should write what it can and report the
 * rest.
 */
/** `asOf` labels the platform snapshot metrics (Stage 24: the scheduler passes the end of the day that just closed). */
export async function rollupAll(range: DateRange, options: { asOf?: Date } = {}): Promise<RollupResult[]> {
  // Stage 21 (ADR-0036): the platform, organisation, cohort and candidate
  // marts join the sweep, so one operator command rebuilds every mart a
  // dashboard reads. Lazy imports keep this module's pure half importable
  // without dragging every rollup's dependencies into a test.
  const [{ rollupPlatform }, { rollupOrganizations }, { rollupCohorts }, { rollupCandidateOutcomes }] = await Promise.all([import('./platform/rollup'), import('./organization/rollup'), import('./finance/cohorts'), import('./candidate/rollup')]);
  const jobs: [string, () => Promise<RollupResult>][] = [
    ['daily_usage', () => rollupUsage(range)],
    ['daily_revenue', () => rollupRevenue(range)],
    ['daily_metrics', () => rollupPlatformMetrics(range)],
    ['platform_metrics', () => rollupPlatform(range, { asOf: options.asOf })],
    ['organization_reporting', () => rollupOrganizations(range)],
    ['subscription_cohorts', () => rollupCohorts()],
    ['candidate_outcomes', async () => {
      const r = await rollupCandidateOutcomes(range);
      return { job: r.job, windowStart: r.windowStart, windowEnd: r.windowEnd, days: r.days, rowsRead: r.applicationsRead + r.matchesRead, rowsWritten: r.outcomeRows + r.matchRows + r.benchmarkRows, status: r.status };
    }],
  ];

  const results: RollupResult[] = [];
  for (const [job, run] of jobs) {
    try {
      results.push(await run());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push(result(job, normalizeRange(range), 0, 0, 0, 'failed', message));
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Reading the rollups back
// ---------------------------------------------------------------------------

/**
 * One user's pre-aggregated usage for a range.
 *
 * This is the read path dashboards should use: an indexed range scan over
 * `DailyUsageRollup` instead of counting raw events on every page load.
 */
export async function readUsageRollups(
  userId: string,
  range: DateRange,
  metrics?: string[],
): Promise<UsageRollupRow[]> {
  const window = normalizeRange(range);
  const days = eachDayKey(window);
  if (days.length === 0) return [];

  const rows = await db.dailyUsageRollup.findMany({
    where: {
      userId,
      day: { in: days },
      ...(metrics && metrics.length > 0 ? { metric: { in: metrics } } : {}),
    },
    select: { day: true, userId: true, metric: true, count: true, valueCents: true },
    orderBy: [{ day: 'asc' }, { metric: 'asc' }],
  });
  return rows;
}

/**
 * Pivot rollup rows into a zero-filled daily series for one metric.
 *
 * Zero-filled because a day with no rows means "nothing happened", and a chart
 * that skips those days silently compresses time.
 */
export function seriesFromRollups(
  rows: UsageRollupRow[],
  metric: string,
  range: DateRange,
): { day: string; count: number; valueCents: number }[] {
  const byDay = new Map<string, { count: number; valueCents: number }>();
  for (const row of rows) {
    if (row.metric !== metric) continue;
    const entry = byDay.get(row.day) ?? { count: 0, valueCents: 0 };
    entry.count += row.count;
    entry.valueCents += row.valueCents;
    byDay.set(row.day, entry);
  }

  return eachDayKey(range).map((day) => ({
    day,
    count: byDay.get(day)?.count ?? 0,
    valueCents: byDay.get(day)?.valueCents ?? 0,
  }));
}
