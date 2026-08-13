import { db } from './db';
import type { BillingInterval } from './types';

export interface QuotaStatus {
  used: number;
  limit: number;
  remaining: number;
  periodEnd: Date;
  planName: string;
  planCode: string;
  interval: string;
  status: string;
  /** True when the applicant can submit at least one more application. */
  canApply: boolean;
}

/** Months covered by one billing interval. */
export function intervalMonths(interval: BillingInterval): number {
  return interval === 'annual' ? 12 : interval === 'quarterly' ? 3 : 1;
}

/** Price for a plan at a given interval, in cents. */
export function priceFor(
  plan: { monthlyPriceCents: number; quarterlyPriceCents: number; annualPriceCents: number },
  interval: BillingInterval,
): number {
  if (interval === 'annual') return plan.annualPriceCents;
  if (interval === 'quarterly') return plan.quarterlyPriceCents;
  return plan.monthlyPriceCents;
}

/** Effective monthly cost, used to show the savings on longer commitments. */
export function monthlyEquivalent(
  plan: { monthlyPriceCents: number; quarterlyPriceCents: number; annualPriceCents: number },
  interval: BillingInterval,
): number {
  return Math.round(priceFor(plan, interval) / intervalMonths(interval));
}

export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(0)}`;
}

/**
 * Read the user's quota, rolling the window forward if the month has elapsed.
 *
 * The application allowance is monthly even on quarterly and annual plans, so
 * the counter resets every month regardless of billing interval.
 */
export async function getQuota(userId: string): Promise<QuotaStatus | null> {
  const subscription = await db.subscription.findUnique({
    where: { userId },
    include: { plan: true },
  });
  if (!subscription) return null;

  let { applicationsUsed, periodStart, periodEnd } = subscription;

  if (new Date() > periodEnd) {
    // Roll forward to the current month rather than crediting every month missed.
    const nextStart = new Date();
    const nextEnd = new Date(nextStart);
    nextEnd.setMonth(nextEnd.getMonth() + 1);

    await db.subscription.update({
      where: { id: subscription.id },
      data: { applicationsUsed: 0, periodStart: nextStart, periodEnd: nextEnd },
    });

    applicationsUsed = 0;
    periodStart = nextStart;
    periodEnd = nextEnd;
  }

  const limit = subscription.plan.applicationsPerMonth;
  const remaining = Math.max(0, limit - applicationsUsed);

  return {
    used: applicationsUsed,
    limit,
    remaining,
    periodEnd,
    planName: subscription.plan.name,
    planCode: subscription.plan.code,
    interval: subscription.interval,
    status: subscription.status,
    canApply: subscription.status !== 'canceled' && remaining > 0,
  };
}

/**
 * Reserve quota for `count` applications.
 *
 * Returns how many were actually granted — a bulk apply for 20 jobs with 8
 * remaining proceeds with 8 rather than failing outright.
 */
export async function consumeQuota(userId: string, count: number): Promise<number> {
  const quota = await getQuota(userId);
  if (!quota || !quota.canApply) return 0;

  const granted = Math.min(count, quota.remaining);
  if (granted <= 0) return 0;

  await db.subscription.update({
    where: { userId },
    data: { applicationsUsed: { increment: granted } },
  });

  return granted;
}

/** Release quota when a submission fails, so a failed apply isn't charged. */
export async function refundQuota(userId: string, count: number): Promise<void> {
  if (count <= 0) return;
  const subscription = await db.subscription.findUnique({ where: { userId } });
  if (!subscription) return;

  await db.subscription.update({
    where: { userId },
    data: { applicationsUsed: Math.max(0, subscription.applicationsUsed - count) },
  });
}

/** Activate or switch a plan, resetting the quota window. */
export async function activatePlan(
  userId: string,
  planCode: string,
  interval: BillingInterval,
  /** Gateway identifiers, when a real payment provider processed the checkout. */
  external?: { customerId?: string; subscriptionId?: string },
): Promise<void> {
  const plan = await db.plan.findUnique({ where: { code: planCode } });
  if (!plan) throw new Error(`Unknown plan: ${planCode}`);

  const now = new Date();
  const renewsAt = new Date(now);
  renewsAt.setMonth(renewsAt.getMonth() + intervalMonths(interval));

  const periodEnd = new Date(now);
  periodEnd.setMonth(periodEnd.getMonth() + 1);

  await db.subscription.upsert({
    where: { userId },
    create: {
      userId,
      planId: plan.id,
      interval,
      status: 'active',
      renewsAt,
      periodStart: now,
      periodEnd,
      applicationsUsed: 0,
      externalCustomerId: external?.customerId ?? null,
      externalSubId: external?.subscriptionId ?? null,
    },
    update: {
      planId: plan.id,
      interval,
      status: 'active',
      renewsAt,
      periodStart: now,
      periodEnd,
      applicationsUsed: 0,
      canceledAt: null,
      // Preserve existing identifiers when a call omits them.
      ...(external?.customerId ? { externalCustomerId: external.customerId } : {}),
      ...(external?.subscriptionId ? { externalSubId: external.subscriptionId } : {}),
    },
  });
}

/** Mark a subscription's lifecycle state from a gateway event. */
export async function setSubscriptionStatus(
  externalSubId: string,
  status: 'active' | 'past_due' | 'canceled',
): Promise<void> {
  const subscription = await db.subscription.findFirst({ where: { externalSubId } });
  if (!subscription) {
    console.warn(`[subscription] no local record for external subscription ${externalSubId}`);
    return;
  }
  await db.subscription.update({
    where: { id: subscription.id },
    data: {
      status,
      canceledAt: status === 'canceled' ? new Date() : null,
    },
  });
}
