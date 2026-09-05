import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { applyToJobs } from '@/lib/services/applicator';
import { assertModePermits, storedApplicationMode } from '@/lib/apply/modes';
import { db } from '@/lib/db';
import { getQuota } from '@/lib/subscription';
import { describeWait, fail, ok, route, tooMany } from '@/lib/api';
import { LIMITS, rateLimit } from '@/lib/rate-limit';

const schema = z.object({
  jobIds: z.array(z.string().min(1)).min(1, 'Select at least one job to apply to.').max(100),
});

/**
 * Apply to one or many jobs. The same endpoint powers a single "Apply" button
 * and "Apply to all" — the client just sends more ids.
 */
export const POST = route(async (request: Request) => {
  const user = await requireUser();

  // The plan quota caps applications per month; this caps how fast they can be
  // requested, so a runaway client cannot burn the AI budget in a loop.
  const limit = await rateLimit('apply', user.id, LIMITS.apply);
  if (!limit.ok) {
    return tooMany(
      `That is a lot of applications at once. Try again in ${describeWait(limit.retryAfterSeconds)}.`,
      limit.retryAfterSeconds,
    );
  }

  const body = schema.parse(await request.json());

  // Stage 12: the applicant's mode decides whether anything is prepared at all.
  const { applicationMode } = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { applicationMode: true } });
  assertModePermits(storedApplicationMode(applicationMode), 'generate_documents');

  const quota = await getQuota(user.id);
  if (!quota) return fail('No active subscription found. Choose a plan to start applying.', 403);
  if (!quota.canApply) {
    return fail(
      `You have used all ${quota.limit} applications in this cycle. Your quota resets on ${quota.periodEnd.toLocaleDateString('en-CA')}, or you can upgrade for more.`,
      403,
    );
  }

  const result = await applyToJobs(user.id, body.jobIds);
  const updated = await getQuota(user.id);

  return ok({ ...result, quota: updated });
});
