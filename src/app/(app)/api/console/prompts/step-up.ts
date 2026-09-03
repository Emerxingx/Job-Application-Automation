import { db } from '@/lib/db';
import { verifyPassword } from '@/lib/auth';
import { fail } from '@/lib/api';
import { consoleRoute, type StaffContext } from '@/lib/crm/auth';
import { PromptGovernanceError } from '@/lib/ai/prompt-registry';
import { LIMITS, rateLimit } from '@/lib/rate-limit';
import { recordSecurityEvent, type RequestMeta } from '@/lib/security-audit';

/**
 * Step-up authentication for prompt governance (MASTER_BUILD_PLAN Stage 03:
 * "step-up authentication for prompt changes").
 *
 * A staff session is a bearer of considerable power; a system prompt is a
 * security control. Changing one requires the actor to prove presence again
 * by re-entering their password. The check is rate-limited on the auth
 * bucket so it cannot be used to guess the password, every failure is
 * audited, and a staff account without a local password (Supabase-only
 * sign-in — Stage 01) cannot step up at all until MFA lands: fail closed.
 */
export class StepUpError extends Error {
  readonly status = 403;
  constructor(message = 'Re-authentication failed. Enter your current password to make this change.') {
    super(message);
    this.name = 'StepUpError';
  }
}

export async function requireStepUp(staff: StaffContext, currentPassword: string, meta: RequestMeta): Promise<void> {
  const limit = rateLimit('auth', `stepup:${staff.id}`, LIMITS.auth);
  if (!limit.ok) throw new StepUpError('Too many re-authentication attempts. Try again later.');

  const user = await db.user.findUnique({ where: { id: staff.id }, select: { passwordHash: true, email: true } });
  const verified = user?.passwordHash ? await verifyPassword(currentPassword, user.passwordHash) : false;
  if (!verified) {
    await recordSecurityEvent({
      event: 'auth.step_up.failed',
      user: { id: staff.id, email: staff.email, role: staff.storedRole },
      actor: { type: 'staff', id: staff.id, email: staff.email, role: staff.role },
      summary: 'Step-up re-authentication failed for a prompt governance action.',
      meta,
    });
    throw new StepUpError();
  }
}

/** consoleRoute plus the two governance errors → clean statuses. */
export function promptGovernanceRoute<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return consoleRoute(async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof StepUpError) return fail(error.message, error.status);
      if (error instanceof PromptGovernanceError) return fail(error.message, error.status);
      throw error;
    }
  });
}
