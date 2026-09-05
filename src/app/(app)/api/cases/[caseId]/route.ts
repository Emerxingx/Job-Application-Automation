import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { caseFail, caseRequest, organizationIdOf } from '@/lib/cases/request';
import { assignCaseManager, closeCase, loadCase, updateCaseGoal } from '@/lib/cases/service';

type Params = { params: Promise<{ caseId: string }> };

/** GET /api/cases/:caseId?organizationId= - the case without its RESTRICTED rows. */
export const GET = route(async (request: Request, { params }: Params) => {
  const { caseId } = await params;
  try {
    const { tenant, actor } = await caseRequest(request, organizationIdOf(request));
    const view = await tenant.run((tx) => loadCase(tx, actor, caseId));
    return ok(view);
  } catch (error) {
    return caseFail(error) ?? Promise.reject(error);
  }
});

const patchSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('assign'), organizationId: z.string().min(1), caseManagerId: z.string().min(1).nullable() }),
  z.object({ action: z.literal('goal'), organizationId: z.string().min(1), employmentGoal: z.string().trim().max(500).optional(), targetOccupationId: z.string().min(1).nullable().optional() }),
  z.object({ action: z.literal('close'), organizationId: z.string().min(1), reason: z.string().trim().min(2).max(200) }),
]);

/** PATCH /api/cases/:caseId - assign (supervisor/admin), goal (the case manager), close. */
export const PATCH = route(async (request: Request, { params }: Params) => {
  const { caseId } = await params;
  const body = patchSchema.parse(await request.json());
  try {
    const { tenant, actor } = await caseRequest(request, body.organizationId);
    const c = await tenant.run((tx) => {
      if (body.action === 'assign') return assignCaseManager(tx, actor, caseId, body.caseManagerId);
      if (body.action === 'goal') return updateCaseGoal(tx, actor, caseId, { employmentGoal: body.employmentGoal, targetOccupationId: body.targetOccupationId });
      return closeCase(tx, actor, caseId, body.reason);
    });
    return ok({ case: { id: c.id, status: c.status, caseManagerId: c.caseManagerId, employmentGoal: c.employmentGoal, targetOccupationId: c.targetOccupationId } });
  } catch (error) {
    return caseFail(error) ?? Promise.reject(error);
  }
});
