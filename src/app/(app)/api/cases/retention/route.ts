import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { caseFail, caseRequest } from '@/lib/cases/request';
import { setRetentionPolicy } from '@/lib/cases/service';

const schema = z.object({ organizationId: z.string().min(1), caseNoteDays: z.number().int(), closedCaseDays: z.number().int(), note: z.string().trim().max(500).optional() });

/** PUT /api/cases/retention - the organisation's retention policy (admin). No policy = no automatic purge. */
export const PUT = route(async (request: Request) => {
  const body = schema.parse(await request.json());
  try {
    const { actor } = await caseRequest(request, body.organizationId);
    const policy = await setRetentionPolicy(actor, body);
    return ok({ policy: { caseNoteDays: policy.caseNoteDays, closedCaseDays: policy.closedCaseDays, note: policy.note, updatedAt: policy.updatedAt } });
  } catch (error) {
    return caseFail(error) ?? Promise.reject(error);
  }
});
