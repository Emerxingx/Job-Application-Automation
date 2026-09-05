/**
 * Subscriptions: the PAYMENT side of an account - which plan, which interval,
 * which gateway, the monthly usage window - and the transitions a gateway or
 * a checkout drives.
 *
 * Stage 15 (ADR-0010, ADR-0030): what the account MAY DO is no longer read
 * from here. `getQuota` reads the applications allowance from the entitlement
 * layer (src/lib/entitlements) and `canApply` no longer looks at
 * `Subscription.status`: a past-due account in its grace window keeps
 * applying, a suspended one has had its plan entitlements revoked, and a
 * comp account with no payment at all applies on its grant. Every transition
 * here - activate, change, trial, cancel, status from a gateway - ends by
 * syncing entitlements, so the two states move together and only through
 * this module.
 */
import { db } from './db';
import { applySubscriptionAccess, expirePlanEntitlementsAt, quantityFor, syncPlanEntitlements } from './entitlements/service';
import type { RequestMeta } from './security-audit';
import type { BillingInterval } from './types';

export interface QuotaStatus {
  used: number;
  limit: number;
  remaining: number;
  periodEnd: Date;
  planName: string;
  planCode: string;
  interval: string;
  /** Payment state, for display. Never the reason an application is refused. */
  status: string;
  /** True when the applicant can submit at least one more application - from entitlements, not from status. */
  canApply: boolean;
}

/** Months covered by one billing interval. */
export function intervalMonths(interval: BillingInterval): number {
  return interval === 'annual' ? 12 : interval === 'quarterly' ? 3 : 1;
}

/** Price for a plan at a given interval, in cents, from the plan row's CAD columns. */
export function priceFor(
  plan: { monthlyPriceCents: number; quarterlyPriceCents: number; annualPriceCents: number },
  interval: BillingInterval,
): number {
  if (interval === 'annual') return plan.annualPriceCents;
  if (interval === 'quarterly') return plan.quarterlyPriceCents;
  return plan.monthlyPriceCents;
}

export interface PlanPriceRow {
  currency: string;
  interval: string;
  amountCents: number;
  externalPriceId: string | null;
  active: boolean;
}

export interface ResolvedPrice {
  amountCents: number;
  currency: string;
  /** The gateway's own price id for this cell, when a PlanPrice row carries one. */
  externalPriceId: string | null;
  /** `plan_price` when a PlanPrice row answered; `plan_columns` when the CAD defaults did (and the currency is then CAD). */
  source: 'plan_price' | 'plan_columns';
}

/**
 * Stage 15: the price a customer is charged, in THEIR currency, from
 * `PlanPrice` when a row for (currency, interval) is active, else the plan
 * row's CAD columns. A USD customer with no USD row is charged CAD - stated
 * in the checkout response, never silently converted. Pure.
 */
export function resolvePrice(
  plan: { monthlyPriceCents: number; quarterlyPriceCents: number; annualPriceCents: number },
  interval: BillingInterval,
  currency: string,
  prices: readonly PlanPriceRow[] = [],
): ResolvedPrice {
  const cell = prices.find((p) => p.active && p.currency === currency && p.interval === interval);
  if (cell) return { amountCents: cell.amountCents, currency, externalPriceId: cell.externalPriceId, source: 'plan_price' };
  return { amountCents: priceFor(plan, interval), currency: 'CAD', externalPriceId: null, source: 'plan_columns' };
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
 * the counter resets every month regardless of billing interval. The LIMIT
 * is the `applications_per_month` entitlement (the plan's grant, a comp, a
 * pilot - whichever is highest) plus the subscription's bonus applications.
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
  void periodStart;

  const entitled = await quantityFor(db, userId, 'applications_per_month');
  const limit = entitled + Math.max(0, subscription.bonusApplications);
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
    canApply: remaining > 0,
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

export interface ActivateOptions {
  /** Gateway identifiers, when a real payment provider processed the checkout. */
  external?: { customerId?: string; subscriptionId?: string };
  /** Who drove it, for the entitlement trail: `system`, `staff:<id>`, `webhook:stripe`. */
  by?: string;
  meta?: RequestMeta;
}

/**
 * Activate or switch a plan, resetting the quota window, then sync the plan's
 * entitlements (the previous plan's rows are revoked as plan_changed; an
 * upgrade or a downgrade takes effect now). Idempotent: activating the same
 * plan twice - a replayed checkout webhook - changes nothing the second time.
 */
export async function activatePlan(
  userId: string,
  planCode: string,
  interval: BillingInterval,
  externalOrOptions?: ActivateOptions['external'] | ActivateOptions,
): Promise<void> {
  const options: ActivateOptions = externalOrOptions && ('external' in externalOrOptions || 'by' in externalOrOptions || 'meta' in externalOrOptions) ? (externalOrOptions as ActivateOptions) : { external: externalOrOptions as ActivateOptions['external'] };
  const external = options.external;
  const plan = await db.plan.findUnique({ where: { code: planCode } });
  if (!plan) throw new Error(`Unknown plan: ${planCode}`);

  const now = new Date();
  const renewsAt = new Date(now);
  renewsAt.setMonth(renewsAt.getMonth() + intervalMonths(interval));

  const periodEnd = new Date(now);
  periodEnd.setMonth(periodEnd.getMonth() + 1);

  const existing = await db.subscription.findUnique({ where: { userId }, select: { planId: true, status: true, interval: true } });
  const samePlanAlreadyActive = existing !== null && existing.planId === plan.id && existing.status === 'active' && existing.interval === interval;

  const subscription = await db.subscription.upsert({
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
    update: samePlanAlreadyActive
      ? {
          // A replay of the same activation keeps the window and the usage: resetting
          // them would hand a customer a second allowance for one payment.
          ...(external?.customerId ? { externalCustomerId: external.customerId } : {}),
          ...(external?.subscriptionId ? { externalSubId: external.subscriptionId } : {}),
        }
      : {
          planId: plan.id,
          interval,
          status: 'active',
          renewsAt,
          periodStart: now,
          periodEnd,
          applicationsUsed: 0,
          canceledAt: null,
          cancelAtPeriodEnd: false,
          trialEndsAt: null,
          suspendedAt: null,
          // Preserve existing identifiers when a call omits them.
          ...(external?.customerId ? { externalCustomerId: external.customerId } : {}),
          ...(external?.subscriptionId ? { externalSubId: external.subscriptionId } : {}),
        },
  });

  await syncPlanEntitlements(db, { userId, subscriptionId: subscription.id, plan, source: 'plan', expiresAt: null, grantedBy: options.by, meta: options.meta });
}

/**
 * Stage 15: start a trial of a plan - the plan's entitlements, source `trial`,
 * expiring when the trial does, on a subscription in status `trialing` with
 * no payment. Refused when the account already holds a paid, active plan.
 */
export async function startTrial(userId: string, planCode: string, days: number, options: { by?: string; meta?: RequestMeta } = {}): Promise<{ trialEndsAt: Date }> {
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('A trial runs between 1 and 90 days.');
  const plan = await db.plan.findUnique({ where: { code: planCode } });
  if (!plan) throw new Error(`Unknown plan: ${planCode}`);
  const existing = await db.subscription.findUnique({ where: { userId }, select: { status: true, externalSubId: true } });
  if (existing && existing.status === 'active' && existing.externalSubId) throw new Error('This account already has a paid plan; a trial is not needed.');
  const now = new Date();
  const trialEndsAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const periodEnd = new Date(now);
  periodEnd.setMonth(periodEnd.getMonth() + 1);
  const subscription = await db.subscription.upsert({
    where: { userId },
    create: { userId, planId: plan.id, interval: 'monthly', status: 'trialing', renewsAt: trialEndsAt, periodStart: now, periodEnd, applicationsUsed: 0, trialEndsAt, provider: 'manual' },
    update: { planId: plan.id, status: 'trialing', renewsAt: trialEndsAt, trialEndsAt, canceledAt: null, cancelAtPeriodEnd: false },
  });
  await syncPlanEntitlements(db, { userId, subscriptionId: subscription.id, plan, source: 'trial', expiresAt: trialEndsAt, grantedBy: options.by, meta: options.meta });
  return { trialEndsAt };
}

/**
 * Stage 15: cancel. At period end (the default): payment stops renewing and
 * the plan's entitlements EXPIRE at the period end - access until then, then
 * the free baseline. Immediately: status canceled and the rows revoked now.
 * A refund is a separate act and is never implied by either.
 */
export async function cancelSubscription(userId: string, options: { immediately?: boolean; by?: string; meta?: RequestMeta } = {}): Promise<{ status: string; accessUntil: Date | null }> {
  const subscription = await db.subscription.findUnique({ where: { userId } });
  if (!subscription) throw new Error('No subscription to cancel.');
  if (options.immediately) {
    await db.subscription.update({ where: { id: subscription.id }, data: { status: 'canceled', canceledAt: new Date(), cancelAtPeriodEnd: false } });
    await applySubscriptionAccess(db, { userId, subscriptionId: subscription.id, state: 'canceled', by: options.by, meta: options.meta });
    return { status: 'canceled', accessUntil: null };
  }
  const until = subscription.renewsAt;
  await db.subscription.update({ where: { id: subscription.id }, data: { cancelAtPeriodEnd: true } });
  await expirePlanEntitlementsAt(db, userId, subscription.id, until);
  return { status: subscription.status, accessUntil: until };
}

/**
 * Mark a subscription's lifecycle state from a gateway event, then apply the
 * access consequence: active (a recovered payment) re-syncs the plan's rows;
 * past_due keeps them (dunning runs); canceled revokes them.
 */
export async function setSubscriptionStatus(
  externalSubId: string,
  status: 'active' | 'past_due' | 'canceled',
  options: { by?: string; meta?: RequestMeta } = {},
): Promise<void> {
  const subscription = await db.subscription.findFirst({ where: { externalSubId }, include: { plan: true } });
  if (!subscription) {
    console.warn(`[subscription] no local record for external subscription ${externalSubId}`);
    return;
  }
  await db.subscription.update({
    where: { id: subscription.id },
    data: {
      status,
      canceledAt: status === 'canceled' ? new Date() : null,
      ...(status === 'past_due' ? { pastDueAt: subscription.pastDueAt ?? new Date() } : {}),
      ...(status === 'active' ? { pastDueAt: null, suspendedAt: null } : {}),
    },
  });
  if (status === 'active') {
    await syncPlanEntitlements(db, { userId: subscription.userId, subscriptionId: subscription.id, plan: subscription.plan, source: 'plan', expiresAt: subscription.cancelAtPeriodEnd ? subscription.renewsAt : null, grantedBy: options.by, meta: options.meta });
  } else {
    await applySubscriptionAccess(db, { userId: subscription.userId, subscriptionId: subscription.id, state: status, by: options.by, meta: options.meta });
  }
}

/**
 * Stage 15: dunning exhausted - the account is suspended: the plan's rows are
 * revoked as payment_lapsed and the account falls to the free baseline (a
 * read-only-ish account: the vault, the folder and eligibility stay; new
 * applications beyond the free allowance do not).
 */
export async function suspendSubscription(userId: string, options: { by?: string; meta?: RequestMeta } = {}): Promise<void> {
  const subscription = await db.subscription.findUnique({ where: { userId } });
  if (!subscription) return;
  await db.subscription.update({ where: { id: subscription.id }, data: { status: 'suspended', suspendedAt: new Date() } });
  await applySubscriptionAccess(db, { userId, subscriptionId: subscription.id, state: 'suspended', by: options.by, meta: options.meta });
}
