import { revokeDeviceSession } from '@/lib/integrations/device-sessions';
import { notFound, v1Ok, v1Route } from '@/lib/integrations/http';
import { requestMeta } from '@/lib/security-audit';
import { db } from '@/lib/db';

/**
 * DELETE /api/v1/auth/sessions/{sessionId} (v1.1) - sign another of the
 * caller's devices out. Scoped by owner: a stranger's id is 404 (contract: Revoked).
 */
export const DELETE = v1Route('write', async (context) => {
  const id = context.params.sessionId ?? '';
  const user = await db.user.findUnique({ where: { id: context.key.userId }, select: { id: true, email: true } });
  if (!user) throw notFound('No such device.');
  const revoked = await revokeDeviceSession(user, id, 'user_revoke', requestMeta(context.request));
  if (!revoked) throw notFound('No such device.');
  return v1Ok(context, { object: 'revoked', id, revoked: true });
});
