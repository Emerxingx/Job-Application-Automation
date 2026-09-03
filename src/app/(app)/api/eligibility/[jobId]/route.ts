import { requireTenant } from '@/lib/tenancy/request';
import { fail, ok, route } from '@/lib/api';
import { eligibilityForPage } from '@/lib/eligibility/page';

/**
 * GET /api/eligibility/:jobId — the candidate's eligibility verdict for one
 * canonical job (Stage 07): outcome, every rule with its status and reason,
 * the rule-set version and when it was evaluated. Never a number. Evaluated
 * on demand when no current verdict is stored.
 */
export const GET = route(async (_request: Request, { params }: { params: Promise<{ jobId: string }> }) => {
  const { user, run } = await requireTenant();
  const { jobId } = await params;
  const job = await run((tx) => tx.job.findUnique({ where: { id: jobId } }));
  if (!job) return fail('Job not found.', 404);
  const { result, verdict } = await eligibilityForPage(user.id, job, run, 'api');
  return ok({ jobId, outcome: verdict.outcome, rules: verdict.rules, rulesVersion: verdict.rulesVersion, evaluatedAt: result.evaluatedAt.toISOString() });
});
