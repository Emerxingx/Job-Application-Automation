import { confirmAssistedSubmission } from '@/lib/services/applicator';
import { loadApplicationDetail } from '@/lib/integrations/candidate-api';
import { ApiRequestError, notFound, v1Ok, v1Route } from '@/lib/integrations/http';

/**
 * POST /api/v1/applications/{applicationId}/confirm - the applicant records that
 * they submitted a prepared application on the employer's own form (scope
 * apply:write). The same move as the web app's button; nothing is sent by
 * JobPilot here (ADR-0016). Returns the folder (contract: ApplicationDetail).
 */
export const POST = v1Route('apply:write', async (context) => {
  const id = context.params.applicationId ?? '';
  const result = await confirmAssistedSubmission(context.key.userId, id);
  if (!result.ok) {
    if (result.reason === 'Application not found.') throw notFound('No such application.');
    throw new ApiRequestError('invalid_request', result.reason ?? 'That could not be confirmed.', 409);
  }
  const application = await loadApplicationDetail(context.key.userId, id);
  if (!application) throw notFound('No such application.');
  return v1Ok(context, application);
});
