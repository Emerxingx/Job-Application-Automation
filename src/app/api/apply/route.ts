import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { applyToJobs } from '@/lib/services/applicator';
import { getQuota } from '@/lib/subscription';
import { fail, ok, route } from '@/lib/api';

const schema = z.object({
  jobIds: z.array(z.string().min(1)).min(1, 'Select at least one job to apply to.').max(100),
});

/**
 * Apply to one or many jobs. The same endpoint powers a single "Apply" button
 * and "Apply to all" — the client just sends more ids.
 */
export const POST = route(async (request: Request) => {
  const user = await requireUser();
  const body = schema.parse(await request.json());

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
