import { revokeDeviceSession } from '@/lib/integrations/device-sessions';
import { ApiRequestError, v1Ok, v1Route } from '@/lib/integrations/http';
import { requestMeta } from '@/lib/security-audit';
import { db } from '@/lib/db';

/**
 * DELETE /api/v1/auth/sessions/current (v1.1) - sign out: revoke the key that
 * made the request. Only a device key can be signed out this way; an
 * integration key is revoked by its owner on the web (contract: Revoked).
 */
export const DELETE = v1Route('read', async (context) => {
  const user = await db.user.findUnique({ where: { id: context.key.userId }, select: { id: true, email: true } });
  if (!user) throw new ApiRequestError('unauthorized', 'Invalid or expired API key.', 401);
  const revoked = await revokeDeviceSession(user, context.key.id, 'logout', requestMeta(context.request));
  if (!revoked) throw new ApiRequestError('invalid_request', 'This key is not a device session; revoke it from the web integrations page.', 409);
  return v1Ok(context, { object: 'revoked', id: context.key.id, revoked: true });
});
