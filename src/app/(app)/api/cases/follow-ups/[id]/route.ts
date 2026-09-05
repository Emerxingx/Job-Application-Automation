import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { caseFail, caseRequest } from '@/lib/cases/request';
import { FOLLOW_UP_STATUSES, updateFollowUp } from '@/lib/cases/service';

const schema = z.object({ organizationId: z.string().min(1), status: z.enum(FOLLOW_UP_STATUSES), note: z.string().trim().max(1000).optional() });

export const PATCH = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = schema.parse(await request.json());
  try {
    const { tenant, actor } = await caseRequest(request, body.organizationId);
    const followUp = await tenant.run((tx) => updateFollowUp(tx, actor, id, body));
    return ok({ followUp });
  } catch (error) {
    return caseFail(error) ?? Promise.reject(error);
  }
});
