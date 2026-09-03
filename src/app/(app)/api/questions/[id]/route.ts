import { requireTenant } from '@/lib/tenancy/request';
import { fail, ok, route } from '@/lib/api';
import { QuestionError, confirmAnswer, deleteQuestion } from '@/lib/evidence/questions';

/** PATCH /api/questions/:id — confirm the stored answer is still current. */
export const PATCH = route(async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { user, run } = await requireTenant();
  const { id } = await params;
  try {
    const question = await run((tx) => confirmAnswer(tx, user.id, id));
    return ok({ question });
  } catch (error) {
    if (error instanceof QuestionError) return fail(error.message, error.status);
    throw error;
  }
});

/** DELETE /api/questions/:id */
export const DELETE = route(async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { user, run } = await requireTenant();
  const { id } = await params;
  try {
    await run((tx) => deleteQuestion(tx, user.id, id));
    return ok({ ok: true });
  } catch (error) {
    if (error instanceof QuestionError) return fail(error.message, error.status);
    throw error;
  }
});
