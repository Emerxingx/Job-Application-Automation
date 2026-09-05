import { listSavedJobs } from '@/lib/integrations/candidate-api';
import { listEnvelope, parsePagination, v1Ok, v1Route } from '@/lib/integrations/http';

/** GET /api/v1/saved-jobs (v1.1) - the caller's saved postings, newest first (contract: SavedJobList). */
export const GET = v1Route('read', async (context) => {
  const pagination = parsePagination(context.url);
  const { data, total } = await listSavedJobs(context.key.userId, pagination);
  return v1Ok(context, listEnvelope(data, pagination, total));
});
