import { db } from '../db';
import { verifyPassword } from '../auth';
import { fail } from '../api';
import { consoleRoute, type StaffContext } from './auth';
import { PromptGovernanceError } from '../ai/prompt-registry';
import { TaxonomyLicenceError } from '../taxonomy/datasets';
import { SourceAccessError } from '../connectors/registry';
import { AtsRulesetError } from '../apply/ats-rulesets';
import { MatchWeightError } from '../matching/weights';
import { FieldMappingError } from '../apply/field-mappings';
import { LIMITS, rateLimit } from '../rate-limit';
import { recordSecurityEvent, type RequestMeta } from '../security-audit';

/**
 * Step-up authentication for governance actions: prompt changes (Stage 03,
 * MASTER_BUILD_PLAN: "step-up authentication for prompt changes"), taxonomy
 * licence records (Stage 04: opening or closing the L-2 gate), and, since
 * Stage 05, job-source enablement and ATS ruleset changes.
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
      summary: 'Step-up re-authentication failed for a governance action.',
      meta,
    });
    throw new StepUpError();
  }
}

/** consoleRoute plus the governance errors → clean statuses. */
export function governanceRoute<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return consoleRoute(async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof StepUpError) return fail(error.message, error.status);
      if (error instanceof PromptGovernanceError) return fail(error.message, error.status);
      if (error instanceof TaxonomyLicenceError) return fail(error.message, error.status);
      if (error instanceof SourceAccessError) return fail(error.message, error.status);
      if (error instanceof AtsRulesetError) return fail(error.message, error.status);
      if (error instanceof MatchWeightError) return fail(error.message, error.status);
      if (error instanceof FieldMappingError) return fail(error.message, error.status);
      throw error;
    }
  });
}
