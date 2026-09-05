import { z } from 'zod';
import { db } from '@/lib/db';
import { createSession, hashPassword } from '@/lib/auth';
import { activatePlan } from '@/lib/subscription';
import { describeWait, fail, ok, route, tooMany } from '@/lib/api';
import { LIMITS, clientAddress, rateLimit } from '@/lib/rate-limit';
import { ensurePersonalWorkspace } from '@/lib/tenancy/organizations';
import { grantConsent, REQUIRED_AT_SIGNUP } from '@/lib/consent';
import { recordSecurityEvent, requestMeta } from '@/lib/security-audit';
import type { BillingInterval } from '@/lib/types';

const schema = z.object({
  fullName: z.string().min(2, 'Please enter your full name.').max(120),
  email: z.string().email('Please enter a valid email address.'),
  password: z.string().min(8, 'Password must be at least 8 characters.'),
  country: z.enum(['CA', 'US']).default('CA'),
  plan: z.string().optional(),
  interval: z.string().optional(),
  // The form posts "on" for a checked box; an API client may post true. Both
  // are accepted; anything else — including absence — is a refusal.
  acceptTerms: z
    .union([z.literal('on'), z.literal(true), z.literal('true')])
    .optional()
    .transform((v) => v !== undefined),
});

export const POST = route(async (request: Request) => {
  const limit = await rateLimit('auth', clientAddress(request), LIMITS.auth);
  if (!limit.ok) {
    return tooMany(
      `Too many sign-up attempts. Try again in ${describeWait(limit.retryAfterSeconds)}.`,
      limit.retryAfterSeconds,
    );
  }

  const body = schema.parse(await request.json());
  const email = body.email.toLowerCase().trim();
  const meta = requestMeta(request);

  if (!body.acceptTerms) {
    return fail('Please accept the Terms of Service and Privacy Policy to create an account.', 422);
  }

  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    return fail('An account with that email already exists. Try signing in instead.', 409);
  }

  const passwordHash = await hashPassword(body.password);
  const fullName = body.fullName.trim();

  // The user, their personal workspace and their consent records commit
  // together or not at all: an account that exists without a workspace has no
  // tenant to act in, and one without consent records was never agreed to.
  const user = await db.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: { email, passwordHash, fullName, country: body.country },
    });
    await ensurePersonalWorkspace(tx, created);
    for (const purpose of REQUIRED_AT_SIGNUP) {
      await grantConsent(tx, created, purpose, { source: 'signup', meta });
    }
    return created;
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

  const sessionId = await createSession(user.id, { method: 'password', meta });
  await recordSecurityEvent({
    event: 'auth.signup',
    user,
    entityType: 'Session',
    entityId: sessionId,
    summary: 'Account created and signed in',
    detail: { method: 'password', country: body.country },
    meta,
  });

  return ok({ ok: true, redirect: '/onboarding' });
});
