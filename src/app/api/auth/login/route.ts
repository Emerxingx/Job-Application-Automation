import { z } from 'zod';
import { db } from '@/lib/db';
import { createSession, verifyPassword } from '@/lib/auth';
import { describeWait, fail, ok, route, tooMany } from '@/lib/api';
import { LIMITS, clientAddress, rateLimit } from '@/lib/rate-limit';

const schema = z.object({
  email: z.string().email('Please enter a valid email address.'),
  password: z.string().min(1, 'Please enter your password.'),
});

export const POST = route(async (request: Request) => {
  // Limited by address, since there is no authenticated user yet. This blunts
  // credential stuffing without locking a legitimate user out of their account.
  const limit = rateLimit('auth', clientAddress(request), LIMITS.auth);
  if (!limit.ok) {
    return tooMany(
      `Too many sign-in attempts. Try again in ${describeWait(limit.retryAfterSeconds)}.`,
      limit.retryAfterSeconds,
    );
  }

  const body = schema.parse(await request.json());
  const email = body.email.toLowerCase().trim();

  const user = await db.user.findUnique({ where: { email } });
  // Same message either way so the response doesn't reveal which emails exist.
  if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
    return fail('That email and password combination is not recognized.', 401);
  }

  await createSession(user.id);

  return ok({ ok: true, redirect: user.onboardedAt ? '/dashboard' : '/onboarding' });
});
