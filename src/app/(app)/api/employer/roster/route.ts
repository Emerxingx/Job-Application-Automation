import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { employerFail, employerRequest } from '@/lib/employer/request';
import { setEmployerRole } from '@/lib/employer/service';
import { EMPLOYER_ROLES } from '@/lib/employer/roles';

const schema = z.object({ organizationId: z.string().min(1), userId: z.string().min(1), serviceRole: z.enum(EMPLOYER_ROLES).nullable() });

/** PATCH /api/employer/roster - an administrator sets a member's hiring role (recruiter · hiring_manager · interviewer · viewer). */
export const PATCH = route(async (request: Request) => {
  const body = schema.parse(await request.json());
  try {
    const { actor } = await employerRequest(request, body.organizationId);
    await setEmployerRole(actor, body.userId, body.serviceRole);
    return ok({ ok: true });
  } catch (error) {
    return employerFail(error) ?? Promise.reject(error);
  }
});
