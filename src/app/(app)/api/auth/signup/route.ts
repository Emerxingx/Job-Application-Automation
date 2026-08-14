import { z } from 'zod';
import { db } from '@/lib/db';
import { createSession, hashPassword } from '@/lib/auth';
import { activatePlan } from '@/lib/subscription';
import { describeWait, fail, ok, route, tooMany } from '@/lib/api';
import { LIMITS, clientAddress, rateLimit } from '@/lib/rate-limit';
import type { BillingInterval } from '@/lib/types';

const schema = z.object({
  fullName: z.string().min(2, 'Please enter your full name.').max(120),
  email: z.string().email('Please enter a valid email address.'),
  password: z.string().min(8, 'Password must be at least 8 characters.'),
  country: z.enum(['CA', 'US']).default('CA'),
  plan: z.string().optional(),
  interval: z.string().optional(),
});

export const POST = route(async (request: Request) => {
  const limit = rateLimit('auth', clientAddress(request), LIMITS.auth);
  if (!limit.ok) {
    return tooMany(
      `Too many sign-up attempts. Try again in ${describeWait(limit.retryAfterSeconds)}.`,
      limit.retryAfterSeconds,
    );
  }

  const body = schema.parse(await request.json());
  const email = body.email.toLowerCase().trim();

  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    return fail('An account with that email already exists. Try signing in instead.', 409);
  }

  const user = await db.user.create({
    data: {
      email,
      passwordHash: await hashPassword(body.password),
      fullName: body.fullName.trim(),
      country: body.country,
    },
  });

  // Everyone starts on a plan so quota logic always has something to read.
  const planCode = body.plan ?? 'starter';
  const interval = (
    ['monthly', 'quarterly', 'annual'].includes(body.interval ?? '') ? body.interval : 'monthly'
  ) as BillingInterval;

  try {
    await activatePlan(user.id, planCode, interval);
  } catch {
    await activatePlan(user.id, 'starter', 'monthly');
  }

  await db.activityEvent.create({
    data: { userId: user.id, type: 'billing', message: 'Welcome to JobPilot AI.' },
  });

  await createSession(user.id);

  return ok({ ok: true, redirect: '/onboarding' });
});
