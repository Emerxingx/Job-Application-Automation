import { z } from 'zod';
import { db } from '@/lib/db';
import { getSessionId, hashPassword, requireUser, revokeAllSessions, verifyPassword } from '@/lib/auth';
import { describeWait, fail, ok, route, tooMany } from '@/lib/api';
import { LIMITS, rateLimit } from '@/lib/rate-limit';
import { recordSecurityEvent, requestMeta } from '@/lib/security-audit';
import { revokeAllDeviceSessions } from '@/lib/integrations/device-sessions';

const schema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password.'),
  newPassword: z.string().min(8, 'New password must be at least 8 characters.').max(200),
});

/**
 * Change the password. Re-authenticates with the current password (a stolen
 * session must not be able to lock the owner out), then revokes every OTHER
 * session: whoever else held one held it on the old credential.
 */
export const POST = route(async (request: Request) => {
  const user = await requireUser();
  // Keyed by USER, not address: the threat is a stolen session guessing the
  // current password online, and the attacker's address is not the owner's.
  const limit = await rateLimit('auth', `password:${user.id}`, LIMITS.auth);
  if (!limit.ok) {
    return tooMany(`Too many attempts. Try again in ${describeWait(limit.retryAfterSeconds)}.`, limit.retryAfterSeconds);
  }
  const body = schema.parse(await request.json());
  const meta = requestMeta(request);

  if (!(await verifyPassword(body.currentPassword, user.passwordHash))) {
    await recordSecurityEvent({
      event: 'auth.login.failed',
      user,
      summary: 'Password change refused: current password incorrect',
      detail: { reason: 'password_change_reauth' },
      meta,
    });
    return fail('Your current password is not correct.', 403);
  }
  if (body.currentPassword === body.newPassword) {
    return fail('Choose a password you have not used before.', 422);
  }

  const current = await getSessionId();
  const changedAt = new Date();
  await db.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(body.newPassword), passwordChangedAt: changedAt },
  });
  // The epoch check in isSessionLive would already reject the older sessions;
  // the explicit revoke records WHY in the row and makes the session list
  // honest immediately.
  const revoked = await revokeAllSessions(user.id, 'password_change', { except: current });
  // Stage 14: a phone signed in on the old credential is a session too.
  const revokedDevices = await revokeAllDeviceSessions(user.id, 'password_change');
  if (current) {
    // Keep the current session alive across its own password change: it was
    // created before `passwordChangedAt`, so bump its createdAt to now.
    await db.session.update({ where: { id: current }, data: { createdAt: changedAt } });
  }

  await recordSecurityEvent({
    event: 'auth.password.changed',
    user,
    summary: 'Password changed; other sessions revoked',
    detail: { revokedOtherSessions: revoked, revokedDevices },
    meta,
  });
  return ok({ ok: true, revokedOtherSessions: revoked, revokedDevices });
});
