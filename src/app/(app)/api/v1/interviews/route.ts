import { listInterviews } from '@/lib/integrations/candidate-api';
import { listEnvelope, parseDateParam, parsePagination, v1Ok, v1Route } from '@/lib/integrations/http';

/** GET /api/v1/interviews - every interview across the caller's folders, soonest first; `from` (ISO-8601) narrows to those scheduled at or after it (contract: InterviewList). */
export const GET = v1Route('read', async (context) => {
  const pagination = parsePagination(context.url);
  const { data, total } = await listInterviews(context.key.userId, pagination, { from: parseDateParam(context.url, 'from') });
  return v1Ok(context, listEnvelope(data, pagination, total));
});
