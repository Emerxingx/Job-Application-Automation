import { z } from 'zod';
import { requireTenant } from '@/lib/tenancy/request';
import { getPaymentProvider } from '@/lib/providers';
import { activatePlan, priceFor } from '@/lib/subscription';
import { fail, ok, route } from '@/lib/api';
import type { BillingInterval } from '@/lib/types';

const schema = z.object({
  planCode: z.string().min(1),
  interval: z.enum(['monthly', 'quarterly', 'annual']),
});

export const POST = route(async (request: Request) => {
  const { user, run } = await requireTenant();
  const body = schema.parse(await request.json());

  // Plan is reference data, readable on the tenant path. The payment provider
  // call below happens outside any transaction.
  const plan = await run((tx) => tx.plan.findUnique({ where: { code: body.planCode } }));
  if (!plan) return fail('That plan is not available.', 404);

  const interval = body.interval as BillingInterval;
  const payments = getPaymentProvider();

  const checkout = await payments.createCheckout({
    userId: user.id,
    email: user.email,
    planCode: plan.code,
    interval,
    amountCents: priceFor(plan, interval),
  });

  // With a real gateway the plan activates on webhook confirmation instead.
  if (checkout.simulated) {
    await activatePlan(user.id, plan.code, interval);
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

  return ok({ url: checkout.url, simulated: checkout.simulated });
});
