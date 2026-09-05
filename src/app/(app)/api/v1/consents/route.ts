import { listConsents } from '@/lib/integrations/candidate-api';
import { listEnvelope, parsePagination, v1Ok, v1Route } from '@/lib/integrations/http';

/** GET /api/v1/consents (v1.1) - every consent purpose with its current state (contract: ConsentList). */
export const GET = v1Route('read', async (context) => {
  const pagination = parsePagination(context.url);
  const all = await listConsents(context.key.userId);
  return v1Ok(context, listEnvelope(all.slice(pagination.offset, pagination.offset + pagination.limit), pagination, all.length));
});
