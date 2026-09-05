import { z } from 'zod';
import { fail, ok } from '@/lib/api';
import { getSessionId, setImpersonationCookie } from '@/lib/auth';
import { requireStaff } from '@/lib/crm/auth';
import { governanceRoute, requireStepUp } from '@/lib/crm/step-up';
import { requestMeta } from '@/lib/security-audit';
import { listImpersonations, startImpersonation } from '@/lib/admin/impersonation';
import { adminFail } from '@/lib/admin/route';

/** GET /api/console/impersonation - recent impersonations (who, whom, why, when, ended). Admin. */
export const GET = governanceRoute(async () => {
  await requireStaff('admin');
  return ok({ impersonations: await listImpersonations() });
});

const schema = z.object({ currentPassword: z.string().min(1, 'Enter your current password.'), userId: z.string().min(1), reason: z.string().trim().min(10).max(500) });

/**
 * POST /api/console/impersonation - start a READ-ONLY, time-boxed (60 min)
 * impersonation of a customer with a reason, under step-up; audited. The
 * response sets the impersonation cookie beside the staff member's own
 * session; every non-GET request is refused until it ends (Stage 20, ADR-0035).
 */
export const POST = governanceRoute(async (request: Request) => {
  const staff = await requireStaff('admin');
  const body = schema.parse(await request.json());
  await requireStepUp(staff, body.currentPassword, requestMeta(request));
  const staffSessionId = await getSessionId();
  if (!staffSessionId) return fail('Please sign in to continue.', 401);
  try {
    const started = await startImpersonation(staff, { userId: body.userId, reason: body.reason, staffSessionId }, requestMeta(request));
    await setImpersonationCookie(started.token, started.endsAt);
    return ok({ impersonation: { id: started.id, endsAt: started.endsAt.toISOString(), readOnly: true, redirect: '/dashboard' } }, { status: 201 });
  } catch (error) {
    return adminFail(error) ?? Promise.reject(error);
  }
});
