import { z } from 'zod';
import { requireTenant } from '@/lib/tenancy/request';
import { fail, ok, route } from '@/lib/api';
import { AUTOMATION_POLICIES, QuestionError, listQuestions, upsertQuestion } from '@/lib/evidence/questions';

/** GET /api/questions — the candidate's question bank. */
export const GET = route(async () => {
  const { user, run } = await requireTenant();
  const questions = await run((tx) => listQuestions(tx, user.id));
  return ok({ questions });
});

const upsertSchema = z.object({
  question: z.string().trim().min(3, 'Enter the question as the employer asks it.').max(1000),
  answer: z.string().max(4000).optional().default(''),
  policy: z.enum(AUTOMATION_POLICIES).nullable().optional(),
  evidenceIds: z.array(z.string().max(40)).max(50).optional(),
});

/**
 * POST /api/questions — add or update by normalised question text. The
 * category, risk and policy floor are computed server-side; a requested
 * policy below the floor is raised, never honoured.
 */
export const POST = route(async (request: Request) => {
  const { user, run } = await requireTenant();
  const body = upsertSchema.parse(await request.json());
  try {
    const question = await run((tx) => upsertQuestion(tx, user.id, body));
    return ok({ question });
  } catch (error) {
    if (error instanceof QuestionError) return fail(error.message, error.status);
    throw error;
  }
});
