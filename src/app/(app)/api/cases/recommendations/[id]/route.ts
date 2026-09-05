import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { caseFail, caseRequest } from '@/lib/cases/request';
import { TASK_KINDS, decideRecommendation } from '@/lib/cases/service';

const schema = z.object({
  organizationId: z.string().min(1),
  status: z.enum(['accepted', 'dismissed']),
  note: z.string().trim().max(1000).optional(),
  createTask: z.object({ kind: z.enum(TASK_KINDS), title: z.string().trim().min(2).max(200), dueAt: z.coerce.date().nullable().optional() }).optional(),
});

/** PATCH /api/cases/recommendations/:id - the case manager decides; accepting creates a task only when asked to. */
export const PATCH = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = schema.parse(await request.json());
  try {
    const { tenant, actor } = await caseRequest(request, body.organizationId);
    const result = await tenant.run((tx) => decideRecommendation(tx, actor, id, body));
    return ok(result);
  } catch (error) {
    return caseFail(error) ?? Promise.reject(error);
  }
});
