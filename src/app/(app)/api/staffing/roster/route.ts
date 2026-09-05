import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { staffingFail, staffingRequest } from '@/lib/staffing/request';
import { setStaffingRole } from '@/lib/staffing/service';
import { STAFFING_ROLES } from '@/lib/staffing/roles';

const schema = z.object({ organizationId: z.string().min(1), userId: z.string().min(1), serviceRole: z.enum(STAFFING_ROLES).nullable() });

/** PATCH /api/staffing/roster - an administrator sets a member's staffing role. */
export const PATCH = route(async (request: Request) => {
  const body = schema.parse(await request.json());
  try {
    const { actor } = await staffingRequest(request, body.organizationId);
    await setStaffingRole(actor, body.userId, body.serviceRole);
    return ok({ ok: true });
  } catch (error) {
    return staffingFail(error) ?? Promise.reject(error);
  }
});
