// Business metrics for staff (/console). Same two-half structure as
// metrics.ts: pure computation first, Prisma loaders at the bottom.
//
// THREE INVARIANTS THIS FILE ENFORCES
//
// 1. CURRENCY IS NEVER MIXED. CAD and USD cents are different units and there
//    is no FX source installed, so every function here is scoped to ONE
//    currency and filters its input to it. Summing them would produce a number
//    that is wrong in both currencies.
//
// 2. MRR IS CONTRACTED, NOT CASH. MRR is what subscribers are committed to pay
//    per month right now. Cash is what actually arrived. An annual plan paid
//    up front contributes 1/12 of its price to MRR each month and its whole
//    price to cash on one day. Confusing the two is the single most common way
//    a SaaS dashboard lies; `RevenueSummary` therefore reports both, named
//    differently, and never adds them.
//
// 3. RATES ARE PARTS PER MILLION. Matching the schema's `*Parts` convention.
//    Every one goes through `rate()`, which returns 0 parts on a zero
//    denominator rather than NaN.

import { db } from '@/lib/db';
import { intervalMonths, priceFor } from '@/lib/subscription';
import { BASE_CURRENCY, PARTS_PER_UNIT, rate, sortByCountDesc, zeroRate } from './types';
import type {
  ChurnMetrics,
  CustomerLifetimeValue,
  DateRange,
  DunningAttemptRow,
  Granularity,
  GroupCount,
  InvoiceRow,
  LtvEstimate,
  MrrMovement,
  MrrSnapshot,
  PaymentHealth,
  PaymentRow,
  PaymentSeriesPoint,
  PlanBreakdown,
  Rate,
  RevenueSeriesPoint,
  RevenueSummary,
  RevenueTotals,
  SubscriberSeriesPoint,
  SubscriptionEventRow,
  SubscriptionRow,
} from './types';
import {
  eachDayKey,
  foldIntoBuckets,
  isWithin,
  normalizeRange,
  rangeOfDays,
  seriesBase,
} from './time';

// ---------------------------------------------------------------------------
// Status vocabularies
// ---------------------------------------------------------------------------

/**
 * Subscription statuses that count toward MRR.
 *
 * `active` obviously. `past_due` and `grace` too: the customer is still
 * contracted and still has access — dunning has not finished failing yet, and
 * writing that revenue off on the first declined card would make MRR bounce
 * every time a card expires. `trialing` does NOT count: nothing has been
 * committed. `suspended` and `canceled` do not count: access is gone.
 */
export const MRR_STATUSES: readonly string[] = ['active', 'past_due', 'grace'];

/** Payment statuses where money genuinely moved, refunds notwithstanding. */
export const SETTLED_PAYMENT_STATUSES: readonly string[] = [
  'succeeded',
  'refunded',
  'partially_refunded',
  'disputed',
];

/** Invoice statuses that represent real billed revenue. Drafts and voids do not. */
export const BILLED_INVOICE_STATUSES: readonly string[] = ['open', 'paid', 'uncollectible'];

export function isMrrEligible(status: string): boolean {
  return MRR_STATUSES.includes(status);
}

export function isSettledPayment(status: string): boolean {
  return SETTLED_PAYMENT_STATUSES.includes(status);
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** Months in a billing interval, tolerating an unrecognised value as monthly. */
export function intervalMonthsOf(interval: string): number {
  return interval === 'monthly' || interval === 'quarterly' || interval === 'annual'
    ? intervalMonths(interval)
    : 1;
}

/**
 * An interval price expressed as monthly cents.
 *
 * Annual $566.40 becomes $47.20/month, not $566.40 of MRR in January and zero
 * for the rest of the year. Integer cents in, integer cents out; the rounding
 * error is at most a cent per subscription per month and never compounds
 * because it is recomputed, not accumulated.
 */
export function monthlyNormalizedCents(amountCents: number, interval: string): number {
  const months = Math.max(1, intervalMonthsOf(interval));
  return Math.round(amountCents / months);
}

/**
 * The MRR one subscription contributes.
 *
 * Prefers the `mrrCents` cache written by the subscription-event writer, and
 * falls back to normalising the plan price when that cache is still zero. The
 * fallback matters: the column defaults to 0, so a dashboard that trusted it
 * blindly would report $0 MRR on a fully paying book of business until the
 * event writer had run at least once against every row.
 */
export function subscriptionMrrCents(subscription: SubscriptionRow): number {
  if (!isMrrEligible(subscription.status)) return 0;
  if (subscription.mrrCents > 0) return subscription.mrrCents;
  return monthlyNormalizedCents(subscription.planPriceCents, subscription.interval);
}

// ---------------------------------------------------------------------------
// MRR / ARR / ARPU
// ---------------------------------------------------------------------------

/** Zeroed snapshot — what a platform with no subscribers reports. */
export function emptyMrrSnapshot(currency: string = BASE_CURRENCY): MrrSnapshot {
  return {
    currency,
    mrrCents: 0,
    arrCents: 0,
    arpuCents: 0,
    activeSubscribers: 0,
    trialingSubscribers: 0,
    pastDueSubscribers: 0,
    suspendedSubscribers: 0,
    canceledSubscribers: 0,
    payingSubscribers: 0,
    byPlan: [],
  };
}

/**
 * Point-in-time MRR from live subscription rows.
 *
 *   MRR  = sum of normalised monthly cents over MRR-eligible subscriptions
 *   ARR  = MRR * 12 (a projection of today's book, not booked revenue)
 *   ARPU = MRR / paying subscribers, rounded to a cent, 0 when there are none
 *
 * ARPU divides by PAYING subscribers, not by all signups: including trials
 * would make ARPU fall every time marketing succeeded.
 */
export function computeMrrSnapshot(
  subscriptions: SubscriptionRow[],
  currency: string = BASE_CURRENCY,
): MrrSnapshot {
  const snapshot = emptyMrrSnapshot(currency);
  const plans = new Map<string, PlanBreakdown>();

  for (const subscription of subscriptions) {
    if (subscription.currency !== currency) continue;

    if (subscription.status === 'trialing') snapshot.trialingSubscribers += 1;
    if (subscription.status === 'active') snapshot.activeSubscribers += 1;
    if (subscription.status === 'past_due') snapshot.pastDueSubscribers += 1;
    if (subscription.status === 'suspended') snapshot.suspendedSubscribers += 1;
    if (subscription.status === 'canceled') snapshot.canceledSubscribers += 1;

    if (!isMrrEligible(subscription.status)) continue;

    // A comped or $0 subscription is a real customer but holds no revenue.
    // Counting it would drag ARPU down without any money changing hands.
    const mrr = subscriptionMrrCents(subscription);
    if (mrr <= 0) continue;

    snapshot.payingSubscribers += 1;
    snapshot.mrrCents += mrr;

    const plan = plans.get(subscription.planCode) ?? {
      planCode: subscription.planCode,
      planName: subscription.planName,
      subscribers: 0,
      mrrCents: 0,
      parts: 0,
    };
    plan.subscribers += 1;
    plan.mrrCents += mrr;
    plans.set(subscription.planCode, plan);
  }

  snapshot.arrCents = snapshot.mrrCents * 12;
  snapshot.arpuCents =
    snapshot.payingSubscribers > 0
      ? Math.round(snapshot.mrrCents / snapshot.payingSubscribers)
      : 0;

  snapshot.byPlan = sortByCountDesc(
    [...plans.values()].map((plan) => ({ key: plan.planCode, count: plan.mrrCents, plan })),
  ).map((entry) => ({
    ...entry.plan,
    parts: rate(entry.plan.mrrCents, snapshot.mrrCents).parts,
  }));

  return snapshot;
}

/**
 * MRR as it stood at an instant, reconstructed from the event log.
 *
 * `Subscription.mrrCents` only knows today. `SubscriptionEvent` is append-only
 * and carries `mrrAfterCents`, so the MRR at any past instant is the sum, over
 * subscriptions, of the most recent event at or before that instant. This is
 * what makes an opening balance and therefore a churn rate possible at all.
 *
 * Pass events sorted ascending by `occurredAt`; ties resolve to the last one
 * in array order.
 */
export function mrrAtInstant(
  events: SubscriptionEventRow[],
  at: Date,
): { mrrCents: number; subscriptions: number } {
  const latest = new Map<string, SubscriptionEventRow>();

  for (const event of events) {
    if (event.occurredAt > at) continue;
    const previous = latest.get(event.subscriptionId);
    if (!previous || event.occurredAt >= previous.occurredAt) {
      latest.set(event.subscriptionId, event);
    }
  }

  let mrrCents = 0;
  let subscriptions = 0;
  for (const event of latest.values()) {
    if (event.mrrAfterCents > 0) {
      mrrCents += event.mrrAfterCents;
      subscriptions += 1;
    }
  }
  return { mrrCents, subscriptions };
}

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

export function emptyMovement(): MrrMovement {
  return {
    newMrrCents: 0,
    expansionMrrCents: 0,
    contractionMrrCents: 0,
    churnedMrrCents: 0,
    reactivationMrrCents: 0,
    netNewMrrCents: 0,
    newSubscribers: 0,
    churnedSubscribers: 0,
    reactivatedSubscribers: 0,
  };
}

/**
 * Decompose the period's MRR change into the five standard movements.
 *
 *   new           first paid subscription for a customer
 *   expansion     an existing subscriber paying more (upgrade, longer interval)
 *   contraction   an existing subscriber paying less (downgrade)
 *   churn         a subscriber stopping entirely
 *   reactivation  a previously churned customer coming back
 *
 * Contraction and churn are reported as POSITIVE magnitudes even though
 * `deltaMrrCents` stores them negative — every board deck reads "churn: $400",
 * not "churn: -$400". `netNewMrrCents` puts the signs back.
 *
 * Subscriber counts are DISTINCT SUBSCRIPTIONS, so a subscription that
 * downgraded twice in one month counts once, not twice.
 */
export function computeMovement(events: SubscriptionEventRow[], range: DateRange): MrrMovement {
  const window = normalizeRange(range);
  const movement = emptyMovement();
  const newSubs = new Set<string>();
  const churnedSubs = new Set<string>();
  const reactivatedSubs = new Set<string>();

  for (const event of events) {
    if (!isWithin(window, event.occurredAt)) continue;
    const delta = Number.isFinite(event.deltaMrrCents) ? event.deltaMrrCents : 0;

    switch (event.movement) {
      case 'new':
        movement.newMrrCents += Math.max(0, delta);
        newSubs.add(event.subscriptionId);
        break;
      case 'expansion':
        movement.expansionMrrCents += Math.max(0, delta);
        break;
      case 'contraction':
        movement.contractionMrrCents += Math.abs(delta);
        break;
      case 'churn':
        movement.churnedMrrCents += Math.abs(delta);
        churnedSubs.add(event.subscriptionId);
        break;
      case 'reactivation':
        movement.reactivationMrrCents += Math.max(0, delta);
        reactivatedSubs.add(event.subscriptionId);
        break;
      default:
        // Events with no movement (status_changed, interval_changed with no
        // price effect) are real events but not MRR movements. Ignoring them
        // is deliberate, not an oversight.
        break;
    }
  }

  movement.newSubscribers = newSubs.size;
  movement.churnedSubscribers = churnedSubs.size;
  movement.reactivatedSubscribers = reactivatedSubs.size;
  movement.netNewMrrCents =
    movement.newMrrCents +
    movement.expansionMrrCents +
    movement.reactivationMrrCents -
    movement.contractionMrrCents -
    movement.churnedMrrCents;

  return movement;
}

/** New / churned / reactivated subscribers per bucket, with the MRR behind them. */
export function subscribersOverTime(
  events: SubscriptionEventRow[],
  range: DateRange,
  granularity: Granularity = 'day',
): SubscriberSeriesPoint[] {
  const points = foldIntoBuckets<SubscriptionEventRow, SubscriberSeriesPoint>(
    events,
    range,
    granularity,
    (event) => event.occurredAt,
    (bucket) => ({
      ...seriesBase(bucket),
      newSubscribers: 0,
      churnedSubscribers: 0,
      reactivatedSubscribers: 0,
      netSubscribers: 0,
      newMrrCents: 0,
      expansionMrrCents: 0,
      contractionMrrCents: 0,
      churnedMrrCents: 0,
      reactivationMrrCents: 0,
      netNewMrrCents: 0,
    }),
    (point, event) => {
      const delta = Number.isFinite(event.deltaMrrCents) ? event.deltaMrrCents : 0;
      switch (event.movement) {
        case 'new':
          point.newSubscribers += 1;
          point.newMrrCents += Math.max(0, delta);
          break;
        case 'expansion':
          point.expansionMrrCents += Math.max(0, delta);
          break;
        case 'contraction':
          point.contractionMrrCents += Math.abs(delta);
          break;
        case 'churn':
          point.churnedSubscribers += 1;
          point.churnedMrrCents += Math.abs(delta);
          break;
        case 'reactivation':
          point.reactivatedSubscribers += 1;
          point.reactivationMrrCents += Math.max(0, delta);
          break;
        default:
          break;
      }
    },
  );

  for (const point of points) {
    point.netSubscribers =
      point.newSubscribers + point.reactivatedSubscribers - point.churnedSubscribers;
    point.netNewMrrCents =
      point.newMrrCents +
      point.expansionMrrCents +
      point.reactivationMrrCents -
      point.contractionMrrCents -
      point.churnedMrrCents;
  }

  return points;
}

// ---------------------------------------------------------------------------
// Churn and retention
// ---------------------------------------------------------------------------

export interface ChurnInput {
  subscribersAtStart: number;
  mrrAtStartCents: number;
  movement: MrrMovement;
}

/**
 * The four retention numbers, all measured against the OPENING balance.
 *
 *   logoChurn           churned subscribers / subscribers at period start
 *   grossMrrChurn       (churned + contraction) MRR / MRR at period start
 *   netMrrChurn         gross churn less expansion and reactivation; negative
 *                       means the surviving cohort grew
 *   netRevenueRetention (start + expansion + reactivation - contraction
 *                        - churned) / start
 *
 * New business is excluded from all four on purpose. Including it lets a good
 * sales month hide a leaking bucket — NRR above 100% while every existing
 * customer shrinks is exactly the signal these numbers exist to expose.
 *
 * Every denominator is the opening balance, so a period that began with
 * nothing yields 0 parts with denominator 0 (rendered "—"), not a divide by
 * zero and not a fictional 100%.
 */
export function computeChurn(input: ChurnInput): ChurnMetrics {
  const { subscribersAtStart, mrrAtStartCents, movement } = input;

  const grossLost = movement.churnedMrrCents + movement.contractionMrrCents;
  const grossGained = movement.expansionMrrCents + movement.reactivationMrrCents;

  return {
    logoChurn: rate(movement.churnedSubscribers, subscribersAtStart),
    grossMrrChurn: rate(grossLost, mrrAtStartCents),
    netMrrChurn: rate(grossLost - grossGained, mrrAtStartCents),
    netRevenueRetention: rate(mrrAtStartCents + grossGained - grossLost, mrrAtStartCents),
  };
}

export function emptyChurn(): ChurnMetrics {
  return {
    logoChurn: zeroRate(),
    grossMrrChurn: zeroRate(),
    netMrrChurn: zeroRate(),
    netRevenueRetention: zeroRate(),
  };
}

// ---------------------------------------------------------------------------
// Lifetime value
// ---------------------------------------------------------------------------

/** Never project a customer lifetime beyond three years. */
export const DEFAULT_LTV_HORIZON_MONTHS = 36;

/**
 * Predicted lifetime value: ARPU divided by the monthly churn rate.
 *
 * The textbook formula `LTV = ARPU / churn` divides by zero for a product that
 * has not churned anyone yet — which is every product in its first month — and
 * produces absurd numbers for a very low churn rate. So the expected lifetime
 * is capped at `horizonMonths` (36 by default): a zero churn rate yields
 * `ARPU * 36` with `capped: true`, not Infinity.
 *
 * This is a PREDICTION over the current book. For cash actually collected from
 * a specific customer, use `computeCustomerLtv`.
 */
export function computeLtv(
  arpuCents: number,
  monthlyChurn: Rate,
  options?: { horizonMonths?: number },
): LtvEstimate {
  const horizon = Math.max(1, options?.horizonMonths ?? DEFAULT_LTV_HORIZON_MONTHS);
  const churnParts = monthlyChurn.parts;

  const uncapped = churnParts > 0 ? PARTS_PER_UNIT / churnParts : Number.POSITIVE_INFINITY;
  const capped = !Number.isFinite(uncapped) || uncapped > horizon;
  const lifetimeMonths = capped ? horizon : uncapped;

  return {
    arpuCents,
    monthlyChurn,
    expectedLifetimeMonths: Math.round(lifetimeMonths * 10) / 10,
    ltvCents: Math.round(arpuCents * lifetimeMonths),
    capped,
  };
}

/**
 * Cash actually collected per customer, net of refunds and gateway fees.
 *
 * Backward-looking and exact — no assumptions, no horizon. Only settled
 * payments count; a failed charge is not lifetime value.
 */
export function computeCustomerLtv(
  payments: PaymentRow[],
  currency: string = BASE_CURRENCY,
): CustomerLifetimeValue[] {
  const byUser = new Map<string, CustomerLifetimeValue>();

  for (const payment of payments) {
    if (payment.currency !== currency) continue;
    if (!isSettledPayment(payment.status)) continue;

    const entry = byUser.get(payment.userId) ?? {
      userId: payment.userId,
      grossCents: 0,
      refundedCents: 0,
      feeCents: 0,
      netCents: 0,
      payments: 0,
    };
    entry.grossCents += payment.amountCents;
    entry.refundedCents += payment.amountRefundedCents;
    entry.feeCents += payment.feeCents;
    entry.payments += 1;
    entry.netCents = entry.grossCents - entry.refundedCents - entry.feeCents;
    byUser.set(payment.userId, entry);
  }

  return [...byUser.values()].sort((a, b) => {
    if (b.netCents !== a.netCents) return b.netCents - a.netCents;
    return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
  });
}

/** Mean net cash per paying customer. 0 when nobody has paid. */
export function averageCustomerLtvCents(values: CustomerLifetimeValue[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((sum, value) => sum + value.netCents, 0) / values.length);
}

// ---------------------------------------------------------------------------
// Cash: invoices and payments
// ---------------------------------------------------------------------------

/**
 * The instant a payment is attributed to.
 *
 * Succeeded payments land on the day they succeeded, failures on the day they
 * failed, and anything still pending on the day it was created — so a payment
 * never disappears from the series just because it has not settled.
 */
export function paymentDate(payment: PaymentRow): Date {
  return payment.succeededAt ?? payment.failedAt ?? payment.createdAt;
}

/** The instant an invoice is attributed to: when it was issued, else created. */
export function invoiceDate(invoice: InvoiceRow): Date {
  return invoice.issuedAt ?? invoice.createdAt;
}

export function emptyRevenueTotals(): RevenueTotals {
  return {
    invoicedCents: 0,
    discountCents: 0,
    taxCents: 0,
    paidCents: 0,
    refundedCents: 0,
    feeCents: 0,
    netCents: 0,
    invoices: 0,
    payments: 0,
  };
}

/**
 * Billed and collected amounts for a period.
 *
 *   invoicedCents  total of open/paid/uncollectible invoices (drafts and voids
 *                  excluded — a draft is not revenue, and a void never was)
 *   paidCents      gross cash from settled payments
 *   netCents       paid - refunded - gateway fees
 *
 * `invoicedCents` and `paidCents` are deliberately not reconciled with each
 * other here: an invoice issued in March and paid in April belongs to March
 * on the accrual line and April on the cash line, and that difference is the
 * point of showing both.
 */
export function computeRevenueTotals(
  invoices: InvoiceRow[],
  payments: PaymentRow[],
  currency: string = BASE_CURRENCY,
): RevenueTotals {
  const totals = emptyRevenueTotals();

  for (const invoice of invoices) {
    if (invoice.currency !== currency) continue;
    if (!BILLED_INVOICE_STATUSES.includes(invoice.status)) continue;
    totals.invoices += 1;
    totals.invoicedCents += invoice.totalCents;
    totals.discountCents += invoice.discountCents;
    totals.taxCents += invoice.taxCents;
  }

  for (const payment of payments) {
    if (payment.currency !== currency) continue;
    if (!isSettledPayment(payment.status)) continue;
    totals.payments += 1;
    totals.paidCents += payment.amountCents;
    totals.refundedCents += payment.amountRefundedCents;
    totals.feeCents += payment.feeCents;
  }

  totals.netCents = totals.paidCents - totals.refundedCents - totals.feeCents;
  return totals;
}

/** Billed and collected amounts per bucket, zero-filled across the range. */
export function revenueOverTime(
  input: { invoices: InvoiceRow[]; payments: PaymentRow[] },
  range: DateRange,
  granularity: Granularity = 'day',
  currency: string = BASE_CURRENCY,
): RevenueSeriesPoint[] {
  const invoices = input.invoices.filter(
    (invoice) => invoice.currency === currency && BILLED_INVOICE_STATUSES.includes(invoice.status),
  );
  const payments = input.payments.filter(
    (payment) => payment.currency === currency && isSettledPayment(payment.status),
  );

  // Two folds over the same range and granularity produce series of identical
  // length and order (both are seeded from `buildBuckets`), so they merge by
  // index without a key lookup.
  const points = foldIntoBuckets<InvoiceRow, RevenueSeriesPoint>(
    invoices,
    range,
    granularity,
    invoiceDate,
    (bucket) => ({
      ...seriesBase(bucket),
      invoices: 0,
      invoicedCents: 0,
      discountCents: 0,
      taxCents: 0,
      payments: 0,
      paidCents: 0,
      refundedCents: 0,
      feeCents: 0,
      netCents: 0,
    }),
    (point, invoice) => {
      point.invoices += 1;
      point.invoicedCents += invoice.totalCents;
      point.discountCents += invoice.discountCents;
      point.taxCents += invoice.taxCents;
    },
  );

  const cash = foldIntoBuckets<
    PaymentRow,
    { payments: number; paidCents: number; refundedCents: number; feeCents: number }
  >(
    payments,
    range,
    granularity,
    paymentDate,
    () => ({ payments: 0, paidCents: 0, refundedCents: 0, feeCents: 0 }),
    (point, payment) => {
      point.payments += 1;
      point.paidCents += payment.amountCents;
      point.refundedCents += payment.amountRefundedCents;
      point.feeCents += payment.feeCents;
    },
  );

  points.forEach((point, position) => {
    const settled = cash[position];
    if (settled) {
      point.payments = settled.payments;
      point.paidCents = settled.paidCents;
      point.refundedCents = settled.refundedCents;
      point.feeCents = settled.feeCents;
    }
    point.netCents = point.paidCents - point.refundedCents - point.feeCents;
  });

  return points;
}

/**
 * Failed-payment counts and reasons.
 *
 * The failure rate divides by attempts that reached a verdict — pending and
 * requires_action charges are excluded from both sides, because a charge
 * awaiting 3-D Secure has neither succeeded nor failed and counting it as
 * either moves the number for no reason.
 */
export function computePaymentHealth(
  payments: PaymentRow[],
  range: DateRange,
  granularity: Granularity = 'day',
  currency: string = BASE_CURRENCY,
): PaymentHealth {
  const window = normalizeRange(range);
  const scoped = payments.filter(
    (payment) => payment.currency === currency && isWithin(window, paymentDate(payment)),
  );

  let succeeded = 0;
  let failed = 0;
  let pending = 0;
  let failedCents = 0;
  const codes = new Map<string, number>();

  for (const payment of scoped) {
    if (payment.status === 'failed') {
      failed += 1;
      failedCents += payment.amountCents;
      const code = payment.failureCode?.trim() || 'unknown';
      codes.set(code, (codes.get(code) ?? 0) + 1);
    } else if (isSettledPayment(payment.status)) {
      succeeded += 1;
    } else {
      pending += 1;
    }
  }

  const topFailureCodes: GroupCount[] = sortByCountDesc(
    [...codes.entries()].map(([key, count]) => ({ key, count })),
  ).map((entry) => ({ ...entry, parts: rate(entry.count, failed).parts }));

  const overTime = foldIntoBuckets<PaymentRow, PaymentSeriesPoint>(
    scoped,
    range,
    granularity,
    paymentDate,
    (bucket) => ({ ...seriesBase(bucket), succeeded: 0, failed: 0, pending: 0, failedCents: 0 }),
    (point, payment) => {
      if (payment.status === 'failed') {
        point.failed += 1;
        point.failedCents += payment.amountCents;
      } else if (isSettledPayment(payment.status)) {
        point.succeeded += 1;
      } else {
        point.pending += 1;
      }
    },
  );

  return {
    currency,
    succeeded,
    failed,
    pending,
    failureRate: rate(failed, failed + succeeded),
    failedCents,
    topFailureCodes,
    overTime,
  };
}

/**
 * Share of dunning retries that recovered the money.
 *
 * Attempts still pending, and attempts skipped because the gateway owns the
 * retry schedule, are excluded from both sides — neither is evidence about
 * whether our dunning works.
 */
export function computeDunningRecovery(attempts: DunningAttemptRow[], range: DateRange): Rate {
  const window = normalizeRange(range);
  let succeeded = 0;
  let resolved = 0;

  for (const attempt of attempts) {
    if (!isWithin(window, attempt.scheduledFor)) continue;
    if (attempt.outcome === 'pending' || attempt.outcome === 'skipped_gateway_owned') continue;
    resolved += 1;
    if (attempt.outcome === 'succeeded') succeeded += 1;
  }

  return rate(succeeded, resolved);
}

// ---------------------------------------------------------------------------
// Assembled result
// ---------------------------------------------------------------------------

export interface RevenueInput {
  subscriptions: SubscriptionRow[];
  events: SubscriptionEventRow[];
  invoices: InvoiceRow[];
  payments: PaymentRow[];
}

export interface RevenueOptions {
  range: DateRange;
  granularity?: Granularity;
  /** Defaults to CAD. Rows in any other currency are ignored, never converted. */
  currency?: string;
  /** Cap on the projected customer lifetime, in months. */
  horizonMonths?: number;
}

/**
 * The whole staff revenue dashboard from one set of arrays.
 *
 * `events` must include every subscription event from before `range.start` as
 * well as those inside it: the opening MRR balance is reconstructed from the
 * full history, and without it churn has no denominator.
 */
export function computeRevenueSummary(
  input: RevenueInput,
  options: RevenueOptions,
): RevenueSummary {
  const range = normalizeRange(options.range);
  const granularity = options.granularity ?? 'day';
  const currency = options.currency ?? BASE_CURRENCY;

  const opening = mrrAtInstant(input.events, range.start);
  const movement = computeMovement(input.events, range);

  const mrr = computeMrrSnapshot(input.subscriptions, currency);
  const churn = computeChurn({
    subscribersAtStart: opening.subscriptions,
    mrrAtStartCents: opening.mrrCents,
    movement,
  });

  return {
    currency,
    range: { start: range.start.toISOString(), end: range.end.toISOString() },
    granularity,
    mrr,
    openingMrrCents: opening.mrrCents,
    openingSubscribers: opening.subscriptions,
    movement,
    churn,
    ltv: computeLtv(mrr.arpuCents, churn.logoChurn, {
      horizonMonths: options.horizonMonths,
    }),
    totals: computeRevenueTotals(input.invoices, input.payments, currency),
    revenueOverTime: revenueOverTime(input, range, granularity, currency),
    subscribersOverTime: subscribersOverTime(input.events, range, granularity),
    paymentHealth: computePaymentHealth(input.payments, range, granularity, currency),
  };
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

/**
 * Live subscriptions with their plan price resolved.
 *
 * `planPriceCents` is the amount actually billed per interval, taken from the
 * existing `priceFor` helper so analytics and checkout can never disagree
 * about what a plan costs.
 */
export async function loadSubscriptionRows(): Promise<SubscriptionRow[]> {
  const rows = await db.subscription.findMany({
    select: {
      id: true,
      userId: true,
      status: true,
      interval: true,
      currency: true,
      mrrCents: true,
      startedAt: true,
      canceledAt: true,
      plan: {
        select: {
          code: true,
          name: true,
          monthlyPriceCents: true,
          quarterlyPriceCents: true,
          annualPriceCents: true,
        },
      },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    status: row.status,
    planCode: row.plan.code,
    planName: row.plan.name,
    interval: row.interval,
    currency: row.currency,
    mrrCents: row.mrrCents,
    planPriceCents: priceFor(
      row.plan,
      row.interval === 'annual' ? 'annual' : row.interval === 'quarterly' ? 'quarterly' : 'monthly',
    ),
    startedAt: row.startedAt,
    canceledAt: row.canceledAt,
  }));
}

/**
 * Every subscription event up to `until`, oldest first.
 *
 * This is a full-history scan by necessity — the opening balance is defined by
 * the whole log. It is also exactly why `DailyRevenueRollup` exists: the daily
 * job pays this cost once, and `loadRevenueFromRollups` reads the answer.
 */
export async function loadSubscriptionEventRows(until: Date): Promise<SubscriptionEventRow[]> {
  const rows = await db.subscriptionEvent.findMany({
    where: { occurredAt: { lt: until } },
    select: {
      userId: true,
      subscriptionId: true,
      type: true,
      movement: true,
      mrrBeforeCents: true,
      mrrAfterCents: true,
      deltaMrrCents: true,
      occurredAt: true,
    },
    orderBy: { occurredAt: 'asc' },
  });
  return rows;
}

export async function loadInvoiceRows(
  range: DateRange,
  currency?: string,
): Promise<InvoiceRow[]> {
  const window = normalizeRange(range);
  const bounds = { gte: window.start, lt: window.end };

  return db.invoice.findMany({
    where: {
      ...(currency ? { currency } : {}),
      // Mirrors `invoiceDate`: issued invoices land on their issue date,
      // unissued drafts on their creation date.
      OR: [{ issuedAt: bounds }, { AND: [{ issuedAt: null }, { createdAt: bounds }] }],
    },
    select: {
      id: true,
      userId: true,
      status: true,
      currency: true,
      subtotalCents: true,
      discountCents: true,
      taxCents: true,
      totalCents: true,
      amountPaidCents: true,
      amountRefundedCents: true,
      amountCreditedCents: true,
      issuedAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });
}

export async function loadPaymentRows(
  range: DateRange,
  currency?: string,
): Promise<PaymentRow[]> {
  const window = normalizeRange(range);
  const bounds = { gte: window.start, lt: window.end };

  return db.payment.findMany({
    where: {
      ...(currency ? { currency } : {}),
      // Mirrors `paymentDate`: succeeded, else failed, else created.
      OR: [
        { succeededAt: bounds },
        { AND: [{ succeededAt: null }, { failedAt: bounds }] },
        { AND: [{ succeededAt: null }, { failedAt: null }, { createdAt: bounds }] },
      ],
    },
    select: {
      id: true,
      userId: true,
      status: true,
      currency: true,
      amountCents: true,
      amountRefundedCents: true,
      feeCents: true,
      failureCode: true,
      createdAt: true,
      succeededAt: true,
      failedAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });
}

export async function loadDunningAttemptRows(range: DateRange): Promise<DunningAttemptRow[]> {
  const window = normalizeRange(range);
  return db.dunningAttempt.findMany({
    where: { scheduledFor: { gte: window.start, lt: window.end } },
    select: { outcome: true, scheduledFor: true },
    orderBy: { scheduledFor: 'asc' },
  });
}

/** The staff revenue dashboard, computed live from the source tables. */
export async function loadRevenueSummary(options?: Partial<RevenueOptions>): Promise<RevenueSummary> {
  const resolved: RevenueOptions = {
    range: options?.range ?? rangeOfDays(30),
    granularity: options?.granularity ?? 'day',
    currency: options?.currency ?? BASE_CURRENCY,
    horizonMonths: options?.horizonMonths,
  };
  const range = normalizeRange(resolved.range);

  const [subscriptions, events, invoices, payments] = await Promise.all([
    loadSubscriptionRows(),
    loadSubscriptionEventRows(range.end),
    loadInvoiceRows(range, resolved.currency),
    loadPaymentRows(range, resolved.currency),
  ]);

  return computeRevenueSummary({ subscriptions, events, invoices, payments }, resolved);
}

/**
 * The fast path: read `DailyRevenueRollup` instead of the source tables.
 *
 * Zero-filled across the requested range, so a day the rollup job has not
 * written yet reads as zero rather than vanishing from the chart. Cash columns
 * are per-currency; the MRR columns live only on the base-currency row (see
 * `rollups.ts`), so a USD query returns zeros for them by design.
 */
export async function loadRevenueFromRollups(
  range: DateRange,
  currency: string = BASE_CURRENCY,
): Promise<RevenueSeriesPoint[]> {
  const window = normalizeRange(range);
  const days = eachDayKey(window);

  const rows = await db.dailyRevenueRollup.findMany({
    where: { currency, day: { in: days } },
    orderBy: { day: 'asc' },
  });
  const byDay = new Map(rows.map((row) => [row.day, row]));

  return foldIntoBuckets<string, RevenueSeriesPoint>(
    days,
    window,
    'day',
    (day) => new Date(`${day}T00:00:00.000Z`),
    (bucket) => ({
      ...seriesBase(bucket),
      invoices: 0,
      invoicedCents: 0,
      discountCents: 0,
      taxCents: 0,
      payments: 0,
      paidCents: 0,
      refundedCents: 0,
      feeCents: 0,
      netCents: 0,
    }),
    (point, day) => {
      const row = byDay.get(day);
      if (!row) return;
      point.invoicedCents += row.invoicedCents;
      point.discountCents += row.discountCents;
      point.taxCents += row.taxCents;
      point.paidCents += row.paidCents;
      point.refundedCents += row.refundedCents;
      point.feeCents += row.feeCents;
      point.netCents += row.netCents;
    },
  );
}
