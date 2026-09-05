import { fail, ok, route } from '@/lib/api';
import { requireUser } from '@/lib/auth';
import { requestMeta } from '@/lib/security-audit';
import { cancelErasure, ErasureError, erasureStatus, requestErasure } from '@/lib/privacy/erasure';

/**
 * Stage 23 (ADR-0037) - the account holder's own erasure: GET the status,
 * POST to schedule (fourteen-day grace), DELETE to cancel within it. The
 * person themselves, never staff; `route()` refuses every write during a
 * support impersonation, so a support session cannot schedule one either.
 */
export const GET = route(async () => {
  const user = await requireUser();
  return ok(await erasureStatus(user.id));
});

export const POST = route(async (request: Request) => {
  const user = await requireUser();
  const body = (await request.json().catch(() => ({}))) as { reason?: unknown };
  try {
    return ok(await requestErasure({ id: user.id, email: user.email }, { reason: typeof body.reason === 'string' ? body.reason : undefined, meta: requestMeta(request) }));
  } catch (error) {
    if (error instanceof ErasureError) return fail(error.message, error.status);
    throw error;
  }
});

export const DELETE = route(async (request: Request) => {
  const user = await requireUser();
  try {
    return ok(await cancelErasure({ id: user.id, email: user.email }, { meta: requestMeta(request) }));
  } catch (error) {
    if (error instanceof ErasureError) return fail(error.message, error.status);
    throw error;
  }
});
