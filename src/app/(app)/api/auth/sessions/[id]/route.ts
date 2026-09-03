import { requireUser, revokeSession } from '@/lib/auth';
import { fail, ok, route } from '@/lib/api';
import { recordSecurityEvent, requestMeta } from '@/lib/security-audit';

/** Revoke one of the account holder's own sessions. Takes effect immediately. */
export const DELETE = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await params;
  // Scoped to the caller inside revokeSession: another user's session id is
  // indistinguishable from a non-existent one, by design.
  const revoked = await revokeSession(user.id, id, 'user_revoke');
  if (!revoked) return fail('Session not found.', 404);
  await recordSecurityEvent({
    event: 'auth.session.revoked',
    user,
    entityType: 'Session',
    entityId: id,
    summary: 'Session revoked by the account holder',
    meta: requestMeta(request),
  });
  return ok({ ok: true });
});
