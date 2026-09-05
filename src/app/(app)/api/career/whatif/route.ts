import { z } from 'zod';
import { requireTenant } from '@/lib/tenancy/request';
import { fail, ok, route } from '@/lib/api';
import { CareerError, credentialWhatIf } from '@/lib/career/service';
import { jobFacts, loadCandidateEligibility } from '@/lib/eligibility/service';
import { quantityFor } from '@/lib/entitlements/service';

const schema = z.object({ credentialId: z.string().min(1), jobId: z.string().min(1) });

/**
 * Stage 16 (ADR-0031): "would this credential change my eligibility for
 * this posting?" - the Stage 07 engine run twice, before and after, on the
 * person's own facts (an audited read, `eligibility.profile.read`, reason
 * `api`) and the posting's stated requirements. The answer is the
 * difference, rule by rule; nothing is inferred and no outcome is promised.
 * Part of the career-transition product: refused when the person's plan
 * includes no analyses at all.
 */
export const POST = route(async (request: Request) => {
  const { user, run } = await requireTenant();
  const body = schema.parse(await request.json());
  const { job, allowed } = await run(async (tx) => ({
    job: await tx.job.findUnique({ where: { id: body.jobId } }),
    allowed: (await quantityFor(tx, user.id, 'career_transition_per_month')) > 0,
  }));
  if (!job) return fail('No such posting.', 404);
  if (!allowed) return fail('Career transition analysis is not included in your plan.', 403);
  const profile = await loadCandidateEligibility(user.id, { reason: 'api', jobs: 1 });
  try {
    const result = await run((tx) => credentialWhatIf(tx, body.credentialId, profile.facts, jobFacts(job)));
    return ok({ whatIf: result });
  } catch (error) {
    if (error instanceof CareerError) return fail(error.message, error.status);
    throw error;
  }
});
