import { loadMe } from '@/lib/integrations/candidate-api';
import { notFound, v1Ok, v1Route } from '@/lib/integrations/http';

/** GET /api/v1/me - the key owner's profile summary (contract: Me). */
export const GET = v1Route('read', async (context) => {
  const me = await loadMe(context.key.userId);
  if (!me) throw notFound('No profile for this key.');
  return v1Ok(context, me);
});
