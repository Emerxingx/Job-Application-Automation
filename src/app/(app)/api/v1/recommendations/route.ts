import { listRecommendations } from '@/lib/integrations/candidate-api';
import { listEnvelope, parsePagination, v1Ok, v1Route } from '@/lib/integrations/http';

/**
 * GET /api/v1/recommendations - the caller's best open, eligible, not-yet-acted-on
 * matches, score first (contract: JobList). A closed posting or one the caller
 * holds an ineligible verdict for never appears (Stages 06 and 07).
 */
export const GET = v1Route('read', async (context) => {
  const pagination = parsePagination(context.url);
  const { data, total } = await listRecommendations(context.key.userId, pagination);
  return v1Ok(context, listEnvelope(data, pagination, total));
});
