import { requireUser } from '@/lib/auth';
import { submitThroughAts } from '@/lib/services/applicator';
import { fail, ok, route } from '@/lib/api';

/**
 * Stage 12 — the applicant instructs JobPilot to submit a prepared
 * application through the employer's authorised ATS API, after reviewing
 * it. Refused unless their mode is Review & submit and the employer has
 * authorised this deployment; never called by anything but this click.
 */
export const POST = route(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await context.params;
  const result = await submitThroughAts(user.id, id);
  if (!result.ok) return fail(result.reason ?? 'That could not be submitted.', 409);
  return ok({ status: 'submitted', confirmation: result.confirmation ?? null });
});
