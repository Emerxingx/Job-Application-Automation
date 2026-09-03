import { ApplicationModeError } from '@/lib/apply/modes';
import { submitThroughAts } from '@/lib/services/applicator';
import { loadApplicationDetail } from '@/lib/integrations/candidate-api';
import { ApiRequestError, notFound, v1Ok, v1Route } from '@/lib/integrations/http';

/**
 * POST /api/v1/applications/{applicationId}/submit - the applicant instructs
 * JobPilot to submit a prepared application through an employer-authorised
 * ATS, after reviewing it (scope apply:write; Stage 12). Refused unless their
 * mode is Review & submit, the record is ready, and the board is authorised;
 * an ATS refusal leaves the record ready for the form. There is no other
 * path from this API to an employer. Returns the folder (contract: ApplicationDetail).
 */
export const POST = v1Route('apply:write', async (context) => {
  const id = context.params.applicationId ?? '';
  let result: Awaited<ReturnType<typeof submitThroughAts>>;
  try {
    result = await submitThroughAts(context.key.userId, id);
  } catch (error) {
    if (error instanceof ApplicationModeError) throw new ApiRequestError('invalid_request', error.message, error.status === 403 ? 403 : 409);
    throw error;
  }
  if (!result.ok) {
    if (result.reason === 'Application not found.') throw notFound('No such application.');
    throw new ApiRequestError('invalid_request', result.reason ?? 'That could not be submitted.', 409);
  }
  const application = await loadApplicationDetail(context.key.userId, id);
  if (!application) throw notFound('No such application.');
  return v1Ok(context, application);
});
