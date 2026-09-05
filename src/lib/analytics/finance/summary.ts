import { db } from '@/lib/db';
import { computeChurn, computeLtv, emptyMrrSnapshot, emptyRevenueTotals } from '../revenue';
import { addUtcDays, dayKey, eachDayKey, foldIntoBuckets, normalizeRange, seriesBase } from '../time';
import { BASE_CURRENCY, rate, type DateRange, type Granularity, type MrrMovement, type PaymentHealth, type PaymentSeriesPoint, type RevenueSeriesPoint, type RevenueSummary, type SubscriberSeriesPoint } from '../types';

/**
 * Stage 21 (ADR-0036) - the revenue summary FROM THE MART. `loadRevenueSummary`
 * (Stage 15) computes the same shape live from subscriptions, events, invoices
 * and payments; this reads `DailyRevenueRollup` only, so the console's
 * overview and revenue pages touch no transactional table. The daily job
 * (`rollupRevenue`) is the one reader of the source tables and the parity
 * test compares the two over the same fixture.
 *
 * What the mart cannot say, said plainly: the plan breakdown (`byPlan`) and
 * the top failure codes are not in the wide row and come back empty; a page
 * that needs them names the limit rather than reading a transactional table.
 */
export interface MartRevenueOptions {
  range: DateRange;
  granularity?: Granularity;
  currency?: string;
  horizonMonths?: number;
}

export async function loadRevenueSummaryFromMarts(options: MartRevenueOptions): Promise<RevenueSummary & { asOfDay: string | null }> {
  const range = normalizeRange(options.range);
  const granularity = options.granularity ?? 'day';
  const currency = options.currency ?? BASE_CURRENCY;
  const days = eachDayKey(range);
  const openingDay = dayKey(addUtcDays(range.start, -1));
  const [rows, opening] = await Promise.all([
    db.dailyRevenueRollup.findMany({ where: { day: { in: days }, currency: { in: [currency, BASE_CURRENCY] } }, orderBy: { day: 'asc' } }),
    db.dailyRevenueRollup.findFirst({ where: { day: { lte: openingDay }, currency: BASE_CURRENCY }, orderBy: { day: 'desc' } }),
  ]);
  const base = rows.filter((r) => r.currency === BASE_CURRENCY);
  const cash = rows.filter((r) => r.currency === currency);
  const last = base[base.length - 1] ?? null;

  const mrr = emptyMrrSnapshot(currency);
  if (last) {
    mrr.mrrCents = last.mrrCents;
    mrr.arrCents = last.arrCents;
    mrr.arpuCents = last.arpuCents;
    mrr.activeSubscribers = last.activeSubscriptions;
    mrr.trialingSubscribers = last.trialingSubscriptions;
    mrr.pastDueSubscribers = last.pastDueSubscriptions;
    mrr.canceledSubscribers = last.canceledSubscriptions;
    mrr.payingSubscribers = last.payingCustomers;
  }
  const movement: MrrMovement = { newMrrCents: 0, expansionMrrCents: 0, contractionMrrCents: 0, churnedMrrCents: 0, reactivationMrrCents: 0, netNewMrrCents: 0, newSubscribers: 0, churnedSubscribers: 0, reactivatedSubscribers: 0 };
  for (const r of base) {
    movement.newMrrCents += r.newMrrCents;
    movement.expansionMrrCents += r.expansionMrrCents;
    movement.contractionMrrCents += r.contractionMrrCents;
    movement.churnedMrrCents += r.churnedMrrCents;
    movement.reactivationMrrCents += r.reactivationMrrCents;
    movement.newSubscribers += r.newCustomers;
    movement.churnedSubscribers += r.churnedCustomers;
  }
  movement.netNewMrrCents = movement.newMrrCents + movement.expansionMrrCents + movement.reactivationMrrCents - movement.contractionMrrCents - movement.churnedMrrCents;
  const openingMrrCents = opening?.mrrCents ?? 0;
  const openingSubscribers = opening?.activeSubscriptions ?? 0;
  const churn = computeChurn({ subscribersAtStart: openingSubscribers, mrrAtStartCents: openingMrrCents, movement });

  const totals = emptyRevenueTotals();
  for (const r of cash) {
    totals.invoicedCents += r.invoicedCents;
    totals.discountCents += r.discountCents;
    totals.taxCents += r.taxCents;
    totals.paidCents += r.paidCents;
    totals.refundedCents += r.refundedCents;
    totals.feeCents += r.feeCents;
    totals.netCents += r.netCents;
    totals.invoices += r.invoicesBilled;
    totals.payments += r.paymentsSucceeded;
  }
  const byDay = new Map(cash.map((r) => [r.day, r]));
  const byDayBase = new Map(base.map((r) => [r.day, r]));
  const revenueOverTime = foldIntoBuckets<string, RevenueSeriesPoint>(days, range, granularity, (d) => new Date(`${d}T00:00:00.000Z`), (b) => ({ ...seriesBase(b), invoices: 0, invoicedCents: 0, discountCents: 0, taxCents: 0, payments: 0, paidCents: 0, refundedCents: 0, feeCents: 0, netCents: 0 }), (p, d) => {
    const r = byDay.get(d);
    if (!r) return;
    p.invoices += r.invoicesBilled;
    p.invoicedCents += r.invoicedCents;
    p.discountCents += r.discountCents;
    p.taxCents += r.taxCents;
    p.payments += r.paymentsSucceeded;
    p.paidCents += r.paidCents;
    p.refundedCents += r.refundedCents;
    p.feeCents += r.feeCents;
    p.netCents += r.netCents;
  });
  const subscribersOverTime = foldIntoBuckets<string, SubscriberSeriesPoint>(days, range, granularity, (d) => new Date(`${d}T00:00:00.000Z`), (b) => ({ ...seriesBase(b), newSubscribers: 0, churnedSubscribers: 0, reactivatedSubscribers: 0, netSubscribers: 0, newMrrCents: 0, expansionMrrCents: 0, contractionMrrCents: 0, churnedMrrCents: 0, reactivationMrrCents: 0, netNewMrrCents: 0 }), (p, d) => {
    const r = byDayBase.get(d);
    if (!r) return;
    p.newSubscribers += r.newCustomers;
    p.churnedSubscribers += r.churnedCustomers;
    p.netSubscribers = p.newSubscribers + p.reactivatedSubscribers - p.churnedSubscribers;
    p.newMrrCents += r.newMrrCents;
    p.expansionMrrCents += r.expansionMrrCents;
    p.contractionMrrCents += r.contractionMrrCents;
    p.churnedMrrCents += r.churnedMrrCents;
    p.reactivationMrrCents += r.reactivationMrrCents;
    p.netNewMrrCents = p.newMrrCents + p.expansionMrrCents + p.reactivationMrrCents - p.contractionMrrCents - p.churnedMrrCents;
  });
  let succeeded = 0;
  let failed = 0;
  let pending = 0;
  let failedCents = 0;
  const overTime = foldIntoBuckets<string, PaymentSeriesPoint>(days, range, granularity, (d) => new Date(`${d}T00:00:00.000Z`), (b) => ({ ...seriesBase(b), succeeded: 0, failed: 0, pending: 0, failedCents: 0 }), (p, d) => {
    const r = byDay.get(d);
    if (!r) return;
    p.succeeded += r.paymentsSucceeded;
    p.failed += r.paymentsFailed;
    p.pending += r.paymentsPending;
    p.failedCents += r.failedPaymentCents;
    failedCents += r.failedPaymentCents;
    succeeded += r.paymentsSucceeded;
    failed += r.paymentsFailed;
    pending += r.paymentsPending;
  });
  const paymentHealth: PaymentHealth = { currency, succeeded, failed, pending, failureRate: rate(failed, failed + succeeded), failedCents, topFailureCodes: [], overTime };
  return {
    currency,
    range: { start: range.start.toISOString(), end: range.end.toISOString() },
    granularity,
    mrr,
    openingMrrCents,
    openingSubscribers,
    movement,
    churn,
    ltv: computeLtv(mrr.arpuCents, churn.logoChurn, { horizonMonths: options.horizonMonths }),
    totals,
    revenueOverTime,
    subscribersOverTime,
    paymentHealth,
    asOfDay: last?.day ?? cash[cash.length - 1]?.day ?? null,
  };
}
