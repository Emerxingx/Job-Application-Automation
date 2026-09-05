import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { caseFail, caseRequest } from '@/lib/cases/request';
import { SERVICE_ROLES } from '@/lib/cases/roles';
import { setServiceRole } from '@/lib/cases/service';

const schema = z.object({ organizationId: z.string().min(1), memberUserId: z.string().min(1), serviceRole: z.enum(SERVICE_ROLES).nullable() });

/** PATCH /api/cases/roster - set a member's service role (admin). */
export const PATCH = route(async (request: Request) => {
  const body = schema.parse(await request.json());
  try {
    const { actor } = await caseRequest(request, body.organizationId);
    await setServiceRole(actor, body.memberUserId, body.serviceRole);
    return ok({ ok: true });
  } catch (error) {
    return caseFail(error) ?? Promise.reject(error);
  }
});
