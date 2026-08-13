import { requireUser } from '@/lib/auth';
import { confirmAssistedSubmission } from '@/lib/services/applicator';
import { fail, ok, route } from '@/lib/api';

/**
 * Record that the applicant completed an assisted application on the
 * employer's own form. Only this explicit confirmation moves a record from
 * `ready_to_submit` to `submitted`.
 */
export const POST = route(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await context.params;

  const result = await confirmAssistedSubmission(user.id, id);
  if (!result.ok) return fail(result.reason ?? 'That could not be confirmed.', 400);

  return ok({ status: 'submitted' });
});
