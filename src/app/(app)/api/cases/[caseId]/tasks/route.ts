import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { caseFail, caseRequest } from '@/lib/cases/request';
import { TASK_KINDS, addTask } from '@/lib/cases/service';

const schema = z.object({
  organizationId: z.string().min(1),
  kind: z.enum(TASK_KINDS),
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(2000).optional(),
  dueAt: z.coerce.date().nullable().optional(),
  offeringId: z.string().min(1).nullable().optional(),
});

/** POST /api/cases/:caseId/tasks - an action-plan item: a task, an intervention, or a referral to a licensed offering. */
export const POST = route(async (request: Request, { params }: { params: Promise<{ caseId: string }> }) => {
  const { caseId } = await params;
  const body = schema.parse(await request.json());
  try {
    const { tenant, actor } = await caseRequest(request, body.organizationId);
    const task = await tenant.run((tx) => addTask(tx, actor, caseId, body));
    return ok({ task }, { status: 201 });
  } catch (error) {
    return caseFail(error) ?? Promise.reject(error);
  }
});
