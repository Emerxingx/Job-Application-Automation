import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { caseFail, caseRequest } from '@/lib/cases/request';
import { TASK_STATUSES, updateTask } from '@/lib/cases/service';

const schema = z.object({
  organizationId: z.string().min(1),
  status: z.enum(TASK_STATUSES).optional(),
  title: z.string().trim().min(2).max(200).optional(),
  description: z.string().trim().max(2000).optional(),
  dueAt: z.coerce.date().nullable().optional(),
});

export const PATCH = route(async (request: Request, { params }: { params: Promise<{ taskId: string }> }) => {
  const { taskId } = await params;
  const body = schema.parse(await request.json());
  try {
    const { tenant, actor } = await caseRequest(request, body.organizationId);
    const task = await tenant.run((tx) => updateTask(tx, actor, taskId, body));
    return ok({ task });
  } catch (error) {
    return caseFail(error) ?? Promise.reject(error);
  }
});
