import { getSessionId, listLiveSessions, requireUser, revokeAllSessions } from '@/lib/auth';
import { ok, route } from '@/lib/api';
import { recordSecurityEvent, requestMeta } from '@/lib/security-audit';
import { listDeviceSessions, revokeAllDeviceSessions } from '@/lib/integrations/device-sessions';

/** The account holder's own live sessions (ADR-0004 §6). */
export const GET = route(async () => {
  const user = await requireUser();
  const current = await getSessionId();
  const sessions = await listLiveSessions(user.id);
  return ok({
    sessions: sessions.map((s) => ({ ...s, current: s.id === current })),
    // Stage 14: the phones signed in with a device key, alongside the browsers.
    devices: await listDeviceSessions(user.id, null),
  });
});

/** "Sign out everywhere else": revoke every session except the current one. */
export const DELETE = route(async (request: Request) => {
  const user = await requireUser();
  const current = await getSessionId();
  const revoked = await revokeAllSessions(user.id, 'user_revoke', { except: current });
  const revokedDevices = await revokeAllDeviceSessions(user.id, 'sign_out_everywhere');
  await recordSecurityEvent({
    event: 'auth.sessions.revoked_all',
    user,
    summary: `Signed out of ${revoked} other session${revoked === 1 ? '' : 's'}`,
    detail: { revoked, revokedDevices, keptCurrent: current !== null },
    meta: requestMeta(request),
  });
  return ok({ ok: true, revoked, revokedDevices });
});
