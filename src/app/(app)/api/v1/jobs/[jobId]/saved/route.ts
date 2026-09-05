import { saveJob, unsaveJob } from '@/lib/integrations/candidate-api';
import { notFound, v1Ok, v1Route } from '@/lib/integrations/http';

/** PUT /api/v1/jobs/{jobId}/saved (v1.1) - save a matched posting; idempotent (contract: SavedJob). */
export const PUT = v1Route('write', async (context) => {
  const saved = await saveJob(context.key.userId, context.params.jobId ?? '');
  if (!saved) throw notFound('No such job.');
  return v1Ok(context, saved);
});

/** DELETE /api/v1/jobs/{jobId}/saved (v1.1) - unsave; idempotent (contract: Revoked). */
export const DELETE = v1Route('write', async (context) => {
  const jobId = context.params.jobId ?? '';
  const ok = await unsaveJob(context.key.userId, jobId);
  if (!ok) throw notFound('No such job.');
  return v1Ok(context, { object: 'revoked', id: jobId, revoked: true });
});
