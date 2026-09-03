import { getSessionId, listLiveSessions, requireUser, revokeAllSessions } from '@/lib/auth';
import { ok, route } from '@/lib/api';
import { recordSecurityEvent, requestMeta } from '@/lib/security-audit';

/** The account holder's own live sessions (ADR-0004 §6). */
export const GET = route(async () => {
  const user = await requireUser();
  const current = await getSessionId();
  const sessions = await listLiveSessions(user.id);
  return ok({
    sessions: sessions.map((s) => ({ ...s, current: s.id === current })),
  });
});

/** "Sign out everywhere else": revoke every session except the current one. */
export const DELETE = route(async (request: Request) => {
  const user = await requireUser();
  const current = await getSessionId();
  const revoked = await revokeAllSessions(user.id, 'user_revoke', { except: current });
  await recordSecurityEvent({
    event: 'auth.sessions.revoked_all',
    user,
    summary: `Signed out of ${revoked} other session${revoked === 1 ? '' : 's'}`,
    detail: { revoked, keptCurrent: current !== null },
    meta: requestMeta(request),
  });
  return ok({ ok: true, revoked });
});
