import { requireUser } from '@/lib/auth';
import { refreshCandidateMarts } from '@/lib/analytics/candidate/rollup';
import { describeWait, ok, route, tooMany } from '@/lib/api';
import { LIMITS, rateLimit } from '@/lib/rate-limit';

/**
 * Stage 13 - the candidate rebuilds their own marts on demand. Bounded to
 * their rows; rate-limited so a page cannot turn into a full-scan loop. The
 * benchmark for those days is rebuilt from the whole mart, never shrunk.
 */
export const POST = route(async () => {
  const user = await requireUser();
  const limit = await rateLimit('analytics_refresh', user.id, LIMITS.analyticsRefresh);
  if (!limit.ok) return tooMany(`Your analytics were refreshed a moment ago. Try again in ${describeWait(limit.retryAfterSeconds)}.`, limit.retryAfterSeconds);
  const result = await refreshCandidateMarts(user.id);
  return ok({ refreshedAt: new Date().toISOString(), applications: result.applicationsRead, matches: result.matchesRead });
});
