'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/lib/db';
import { UnauthorizedError } from '@/lib/auth';
import { StaffAccessError, requireStaff, type StaffContext } from '@/lib/crm/auth';
import { logActivity } from '@/lib/crm/activities';
import { intervalMonths } from '@/lib/subscription';
import type { BillingInterval } from '@/lib/types';

/**
 * Staff-initiated subscription management for the client dashboard.
 *
 * Same discipline as the invoice actions: a Server Action is a POST endpoint
 * wearing a function's clothes, so it repeats the staff gate itself (layouts
 * do not run for actions), demands `billing_ops` because every one of these
 * changes what a customer is entitled to or charged, requires a written
 * reason, and writes an append-only audit row with before/after snapshots.
 *
 * Boundary with the payment gateway, stated plainly: these actions change the
 * subscription record that drives quota and access in THIS system. For a
 * Stripe-owned subscription they do not silently rewrite the gateway — a plan
 * change made here on a `provider: "stripe"` subscription is flagged in the
 * result so the operator knows to mirror it in Stripe (or the webhook will
 * eventually disagree). Manual/comp subscriptions are fully owned here.
 */

export interface ActionResult {
  ok: boolean;
  message: string;
}

const reasonSchema = z
  .string()
  .trim()
  .min(12, 'Say why — a ticket number, a conversation, an agreement. Twelve characters minimum.')
  .max(500);

async function gate(): Promise<{ staff: StaffContext } | { error: ActionResult }> {
  try {
    return { staff: await requireStaff('billing_ops') };
  } catch (error) {
    if (error instanceof StaffAccessError) return { error: { ok: false, message: error.message } };
    if (error instanceof UnauthorizedError) {
      return { error: { ok: false, message: 'Your session has expired. Sign in again.' } };
    }
    throw error;
  }
}

function subscriptionSnapshot(s: {
  planId: string;
  interval: string;
  status: string;
  bonusApplications: number;
  cancelAtPeriodEnd: boolean;
  renewsAt: Date;
}) {
  return {
    planId: s.planId,
    interval: s.interval,
    status: s.status,
    bonusApplications: s.bonusApplications,
    cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    renewsAt: s.renewsAt.toISOString(),
  };
}

async function writeAudit(input: {
  staff: StaffContext;
  action: string;
  subscriptionId: string;
  summary: string;
  before: unknown;
  after: unknown;
  changedFields: string[];
  reason: string;
}): Promise<void> {
  await db.auditLog.create({
    data: {
      actorType: 'staff',
      actorId: input.staff.id,
      actorEmail: input.staff.email,
      actorRole: input.staff.role,
      action: input.action,
      entityType: 'Subscription',
      entityId: input.subscriptionId,
      summary: input.summary,
      before: JSON.stringify(input.before),
      after: JSON.stringify(input.after),
      changedFields: JSON.stringify(input.changedFields),
      reason: input.reason,
    },
  });
}

// --- change plan -----------------------------------------------------------

const changePlanSchema = z.object({
  userId: z.string().trim().min(1).max(40),
  planCode: z.string().trim().min(1).max(40),
  interval: z.enum(['monthly', 'quarterly', 'annual']),
  reason: reasonSchema,
});

/**
 * Move a client to a different plan/interval, effective immediately.
 *
 * Deliberately preserves the current usage counter and period window: a
 * mid-cycle upgrade grants the new (higher) allowance against the same window
 * rather than resetting usage to zero, so a client cannot farm resets by
 * flip-flopping plans. Renewal is recomputed from now for the new interval.
 */
export async function changePlanAction(input: {
  userId: string;
  planCode: string;
  interval: BillingInterval;
  reason: string;
}): Promise<ActionResult> {
  const g = await gate();
  if ('error' in g) return g.error;

  const parsed = changePlanSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid request.' };
  }
  const { userId, planCode, interval, reason } = parsed.data;

  const [subscription, plan] = await Promise.all([
    db.subscription.findUnique({ where: { userId }, include: { plan: true } }),
    db.plan.findUnique({ where: { code: planCode } }),
  ]);
  if (!subscription) return { ok: false, message: 'This client has no subscription to change.' };
  if (!plan) return { ok: false, message: `Unknown plan "${planCode}".` };
  if (subscription.planId === plan.id && subscription.interval === interval) {
    return { ok: true, message: 'Already on that plan and interval — nothing to change.' };
  }

  const before = subscriptionSnapshot(subscription);

  const renewsAt = new Date();
  renewsAt.setMonth(renewsAt.getMonth() + intervalMonths(interval));

  const updated = await db.subscription.update({
    where: { userId },
    data: { planId: plan.id, interval, renewsAt, canceledAt: null, cancelAtPeriodEnd: false },
  });

  await writeAudit({
    staff: g.staff,
    action: 'plan.change',
    subscriptionId: subscription.id,
    summary: `Moved ${subscription.plan.name} → ${plan.name} (${interval}).`,
    before,
    after: subscriptionSnapshot(updated),
    changedFields: ['planId', 'interval', 'renewsAt'],
    reason,
  });
  await logActivity({ userId, staff: g.staff, type: 'billing', subject: 'Plan changed', body: `Plan changed to ${plan.name} (${interval}).` });

  revalidatePath(`/console/customers/${userId}`);

  const gatewayNote =
    subscription.provider === 'stripe' && subscription.externalSubId
      ? ' Note: this subscription is billed by Stripe — mirror the change there or the next webhook will disagree.'
      : '';
  return { ok: true, message: `Plan changed to ${plan.name} (${interval}).${gatewayNote}` };
}

// --- grant bonus applications ----------------------------------------------

const grantSchema = z.object({
  userId: z.string().trim().min(1).max(40),
  count: z.number().int().min(1).max(500),
  reason: reasonSchema,
});

/**
 * Grant goodwill applications on top of the plan allowance for the current
 * window. Bounded (1–500) so a typo cannot mint an effectively unlimited
 * account, and additive so repeated grants remain visible in the audit trail
 * rather than overwriting each other.
 */
export async function grantBonusApplicationsAction(input: {
  userId: string;
  count: number;
  reason: string;
}): Promise<ActionResult> {
  const g = await gate();
  if ('error' in g) return g.error;

  const parsed = grantSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid request.' };
  }
  const { userId, count, reason } = parsed.data;

  const subscription = await db.subscription.findUnique({ where: { userId } });
  if (!subscription) return { ok: false, message: 'This client has no subscription.' };

  const before = subscriptionSnapshot(subscription);
  const updated = await db.subscription.update({
    where: { userId },
    data: { bonusApplications: { increment: count } },
  });

  await writeAudit({
    staff: g.staff,
    action: 'customer.credit',
    subscriptionId: subscription.id,
    summary: `Granted ${count} bonus application${count === 1 ? '' : 's'} (now ${updated.bonusApplications}).`,
    before,
    after: subscriptionSnapshot(updated),
    changedFields: ['bonusApplications'],
    reason,
  });
  await logActivity({ userId, staff: g.staff, type: 'billing', subject: 'Bonus applications granted', body: `${count} bonus application${count === 1 ? '' : 's'} granted.` });

  revalidatePath(`/console/customers/${userId}`);
  return { ok: true, message: `Granted ${count} bonus application${count === 1 ? '' : 's'}.` };
}

// --- cancel at period end / reactivate ---------------------------------------

const cancelSchema = z.object({
  userId: z.string().trim().min(1).max(40),
  reason: reasonSchema,
});

/**
 * Cancel at period end — never immediately. The client keeps what they paid
 * for until the window closes; immediate termination with a refund is a
 * different, gateway-owned operation and deliberately not offered here.
 */
export async function cancelAtPeriodEndAction(input: {
  userId: string;
  reason: string;
}): Promise<ActionResult> {
  const g = await gate();
  if ('error' in g) return g.error;

  const parsed = cancelSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid request.' };
  }
  const { userId, reason } = parsed.data;

  const subscription = await db.subscription.findUnique({ where: { userId } });
  if (!subscription) return { ok: false, message: 'This client has no subscription.' };
  if (subscription.cancelAtPeriodEnd) {
    return { ok: true, message: 'Already set to cancel at period end.' };
  }

  const before = subscriptionSnapshot(subscription);
  const updated = await db.subscription.update({
    where: { userId },
    data: { cancelAtPeriodEnd: true, canceledAt: new Date() },
  });

  await writeAudit({
    staff: g.staff,
    action: 'subscription.cancel_at_period_end',
    subscriptionId: subscription.id,
    summary: `Set to cancel at period end (${subscription.periodEnd.toISOString().slice(0, 10)}).`,
    before,
    after: subscriptionSnapshot(updated),
    changedFields: ['cancelAtPeriodEnd', 'canceledAt'],
    reason,
  });
  await logActivity({ userId, staff: g.staff, type: 'billing', subject: 'Cancellation scheduled', body: 'Subscription set to cancel at period end.' });

  revalidatePath(`/console/customers/${userId}`);

  const gatewayNote =
    subscription.provider === 'stripe' && subscription.externalSubId
      ? ' Mirror this in Stripe so the gateway stops billing.'
      : '';
  return { ok: true, message: `Will cancel at period end.${gatewayNote}` };
}

/** Undo a scheduled cancellation before the period closes. */
export async function reactivateSubscriptionAction(input: {
  userId: string;
  reason: string;
}): Promise<ActionResult> {
  const g = await gate();
  if ('error' in g) return g.error;

  const parsed = cancelSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid request.' };
  }
  const { userId, reason } = parsed.data;

  const subscription = await db.subscription.findUnique({ where: { userId } });
  if (!subscription) return { ok: false, message: 'This client has no subscription.' };
  if (!subscription.cancelAtPeriodEnd) {
    return { ok: true, message: 'This subscription is not scheduled to cancel.' };
  }

  const before = subscriptionSnapshot(subscription);
  const updated = await db.subscription.update({
    where: { userId },
    data: { cancelAtPeriodEnd: false, canceledAt: null, status: 'active' },
  });

  await writeAudit({
    staff: g.staff,
    action: 'subscription.reactivate',
    subscriptionId: subscription.id,
    summary: 'Scheduled cancellation removed; subscription active again.',
    before,
    after: subscriptionSnapshot(updated),
    changedFields: ['cancelAtPeriodEnd', 'canceledAt', 'status'],
    reason,
  });
  await logActivity({ userId, staff: g.staff, type: 'billing', subject: 'Subscription reactivated', body: 'Scheduled cancellation removed.' });

  revalidatePath(`/console/customers/${userId}`);
  return { ok: true, message: 'Subscription reactivated.' };
}
