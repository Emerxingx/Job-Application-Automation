import { z } from 'zod';
import { requireTenant } from '@/lib/tenancy/request';
import { getPaymentProvider } from '@/lib/providers';
import { activatePlan, resolvePrice } from '@/lib/subscription';
import { ensureBillingProfile } from '@/lib/billing/profile';
import { fail, ok, route } from '@/lib/api';
import type { BillingInterval } from '@/lib/types';

const schema = z.object({
  planCode: z.string().min(1),
  interval: z.enum(['monthly', 'quarterly', 'annual']),
});

/**
 * Start a checkout. Stage 15: the price is resolved in the customer's own
 * currency from `PlanPrice` (falling back to the plan's CAD columns, and
 * saying so), their `BillingProfile` exists before any money moves, and
 * activation on a real gateway happens on the webhook - never here.
 */
export const POST = route(async (request: Request) => {
  const { user, run } = await requireTenant();
  const body = schema.parse(await request.json());

  // Plan and its prices are reference data, readable on the tenant path; the
  // billing profile is the user's own row. The payment provider call below
  // happens outside any transaction.
  const [plan, profile] = await run(async (tx) => [
    await tx.plan.findUnique({ where: { code: body.planCode }, include: { prices: { where: { active: true } } } }),
    await ensureBillingProfile(tx, { id: user.id, email: user.email, fullName: user.fullName, country: user.country, city: user.city }),
  ]);
  if (!plan) return fail('That plan is not available.', 404);

  const interval = body.interval as BillingInterval;
  const payments = getPaymentProvider();
  // A real gateway charges by its own price id; a cell without one is not
  // chargeable in its currency and the CAD default applies (stated below).
  const price = resolvePrice(plan, interval, profile.currency, plan.prices, { requireExternalPriceId: payments.name !== 'mock' && payments.name !== 'manual' });

  const checkout = await payments.createCheckout({
    userId: user.id,
    email: profile.billingEmail,
    planCode: plan.code,
    interval,
    amountCents: price.amountCents,
    currency: price.currency,
    externalPriceId: price.externalPriceId,
  });

  // With a real gateway the plan activates on webhook confirmation instead.
  if (checkout.simulated) {
    await activatePlan(user.id, plan.code, interval, { by: 'checkout:simulated' });
    await run((tx) =>
      tx.activityEvent.create({
        data: {
          userId: user.id,
          type: 'billing',
          message: `Switched to the ${plan.name} plan, billed ${interval}.`,
        },
      }),
    );
  }

  return ok({
    url: checkout.url,
    simulated: checkout.simulated,
    price: { amountCents: price.amountCents, currency: price.currency, source: price.source },
    // Honest when a customer's currency has no price cell yet: they are charged the CAD default.
    currencyNote: price.currency === profile.currency ? null : `No ${profile.currency} price is configured for this plan; the CAD price applies.`,
  });
});
