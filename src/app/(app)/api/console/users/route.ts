import { z } from 'zod';
import { fail, ok } from '@/lib/api';
import { requireStaff } from '@/lib/crm/auth';
import { governanceRoute, requireStepUp } from '@/lib/crm/step-up';
import { requestMeta } from '@/lib/security-audit';
import { PLATFORM_ROLES, findUserByEmail, revokeUserSessions, setPlatformRole } from '@/lib/admin/users';
import { adminFail } from '@/lib/admin/route';

/** GET /api/console/users?email= - one account: role, live sessions (ids and methods), memberships. Support and above. */
export const GET = governanceRoute(async (request: Request) => {
  await requireStaff('support');
  const email = new URL(request.url).searchParams.get('email');
  if (!email) return fail('email is required.', 422);
  const user = await findUserByEmail(email);
  if (!user) return fail('No such user.', 404);
  return ok({ user });
});

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('role'), currentPassword: z.string().min(1), userId: z.string().min(1), role: z.enum(PLATFORM_ROLES), reason: z.string().trim().min(3).max(500) }),
  z.object({ action: z.literal('revoke_sessions'), currentPassword: z.string().min(1), userId: z.string().min(1), reason: z.string().trim().min(3).max(500) }),
]);

/** PATCH /api/console/users - set the platform role (assignment of a rank defined in code) or sign the person out everywhere. Admin, step-up, audited (Stage 20, ADR-0035). */
export const PATCH = governanceRoute(async (request: Request) => {
  const staff = await requireStaff('admin');
  const body = schema.parse(await request.json());
  await requireStepUp(staff, body.currentPassword, requestMeta(request));
  try {
    if (body.action === 'role') {
      const user = await setPlatformRole(staff, body.userId, body.role, body.reason, requestMeta(request));
      return ok({ user });
    }
    const count = await revokeUserSessions(staff, body.userId, body.reason, requestMeta(request));
    return ok({ revoked: count });
  } catch (error) {
    return adminFail(error) ?? Promise.reject(error);
  }
});
