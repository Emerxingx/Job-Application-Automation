/**
 * DELETE /api/integrations/keys/:id — revoke a key.
 *
 * Revocation, not deletion. The row stays so `requestCount` and `lastUsedAt`
 * remain available after the fact — "was this leaked key used, and when did it
 * stop?" is exactly the question asked during an incident, and it is
 * unanswerable if revoking erases the evidence.
 *
 * The effect is immediate: `authenticateApiKey` checks `revokedAt` on every
 * request, and there is no cache in front of it.
 */

import { requireUser } from '@/lib/auth';
import { fail, ok, route } from '@/lib/api';
import { revokeApiKey } from '@/lib/integrations/api-keys';

type Params = { params: Promise<{ id: string }> };

export const DELETE = route(async (_request: Request, { params }: Params) => {
  const user = await requireUser();
  const { id } = await params;

  // revokeApiKey scopes its own lookup to the user, so a key belonging to
  // someone else is indistinguishable from one that does not exist.
  const key = await revokeApiKey(user.id, id);
  if (!key) return fail('API key not found.', 404);

  return ok({ key });
});
