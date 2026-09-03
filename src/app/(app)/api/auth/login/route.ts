import { z } from 'zod';
import { db } from '@/lib/db';
import { createSession, verifyPassword } from '@/lib/auth';
import { describeWait, fail, ok, route, tooMany } from '@/lib/api';
import { LIMITS, clientAddress, rateLimit } from '@/lib/rate-limit';
import { hashEmail, recordSecurityEvent, requestMeta } from '@/lib/security-audit';

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
  const meta = requestMeta(request);

  const user = await db.user.findUnique({ where: { email } });
  // Same message either way so the response doesn't reveal which emails exist.
  if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
    // The failure is recorded against the DIGEST of the address, never the
    // address: an attacker's guesses must not populate the audit log with
    // strangers' emails, but repeated failures against one account must still
    // be correlatable.
    await recordSecurityEvent({
      event: 'auth.login.failed',
      actor: { type: 'system' },
      entityType: 'User',
      entityId: user?.id ?? '',
      summary: 'Sign-in failed',
      detail: { emailHash: hashEmail(email), accountExists: user !== null },
      meta,
    });
    return fail('That email and password combination is not recognized.', 401);
  }

  const sessionId = await createSession(user.id, { method: 'password', meta });
  await recordSecurityEvent({
    event: 'auth.login.succeeded',
    user,
    entityType: 'Session',
    entityId: sessionId,
    summary: 'Signed in',
    detail: { method: 'password' },
    meta,
  });

  return ok({ ok: true, redirect: user.onboardedAt ? '/dashboard' : '/onboarding' });
});
