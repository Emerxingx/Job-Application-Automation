import { loadJobDetail } from '@/lib/integrations/candidate-api';
import { notFound, v1Ok, v1Route } from '@/lib/integrations/http';

/** GET /api/v1/jobs/{jobId} - one posting the caller's agents matched, with its text and the caller's eligibility verdict (contract: JobDetail). */
export const GET = v1Route('read', async (context) => {
  const job = await loadJobDetail(context.key.userId, context.params.jobId ?? '');
  if (!job) throw notFound('No such job among your matches.');
  return v1Ok(context, job);
});
