/**
 * GET /api/v1/ats-rulesets/{platform} — the active automation ruleset for a
 * job board, served on the hot path for the automation engine.
 *
 *     curl "https://jobpilot.ai/api/v1/ats-rulesets/greenhouse" \
 *       -H "Authorization: Bearer jp_live_8f3a2b1c_…"
 *
 * Stage 05 moved the registry out of the CMS into the governed `AtsRuleset`
 * table (src/lib/apply/ats-rulesets.ts): a version serves only after a
 * second admin approved it and an admin activated it, and activation
 * invalidates the cache so a rollback is immediate. The response is served
 * from cache (Redis in production, in-memory in dev); a miss does one
 * indexed query.
 *
 * Read-only: requires the `read` scope. Rulesets are shared configuration,
 * not per-customer data, so there is no ownership scoping here — but only an
 * authenticated key may read them, because the selector maps describe how
 * the automation works.
 */

import { getActiveAtsRuleset, isAtsPlatform, ATS_PLATFORMS } from '@/lib/apply/ats-rulesets';
import { getCache } from '@/lib/cache';
import { v1Route, v1Ok } from '@/lib/integrations/http';
import { apiError } from '@/lib/integrations/http';

export const GET = v1Route('read', async (context) => {
  const platform = decodeURIComponent(context.url.pathname.split('/').filter(Boolean).pop() ?? '')
    .toLowerCase()
    .trim();

  if (!isAtsPlatform(platform)) {
    return apiError('not_found', `Unknown ATS platform "${platform}". Supported: ${ATS_PLATFORMS.join(', ')}.`, 404);
  }

  const startedAt = performance.now();
  const ruleset = await getActiveAtsRuleset(platform);
  const lookupMs = Math.round((performance.now() - startedAt) * 1000) / 1000;

  if (!ruleset) {
    return apiError('not_found', `No active ruleset configured for "${platform}".`, 404);
  }

  return v1Ok(context, {
    data: ruleset,
    meta: {
      cacheBackend: getCache().backend,
      lookupMs,
    },
  });
});
