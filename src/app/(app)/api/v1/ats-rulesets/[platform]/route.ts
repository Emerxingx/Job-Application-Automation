/**
 * GET /api/v1/ats-rulesets/{platform} — the active automation ruleset for a
 * job board, served on the hot path for the scraper/automation engine.
 *
 *     curl "https://jobpilot.ai/api/v1/ats-rulesets/greenhouse" \
 *       -H "Authorization: Bearer jp_live_8f3a2b1c_…"
 *
 * The engine calls this before driving each application form. The response is
 * served from cache (Redis in production, in-memory in dev) so a hit is a
 * sub-10ms lookup that never touches the database; a miss does one indexed
 * query, populates the cache, and returns. An operator activating a new
 * ruleset version in the CMS invalidates the cache immediately via the
 * collection's afterChange hook, so there is no wait for a TTL.
 *
 * Read-only: requires the `read` scope. Rulesets are shared configuration, not
 * per-customer data, so there is no ownership scoping here — but only an
 * authenticated key may read them, because the selector maps are competitive
 * intelligence about how the automation works.
 */

import { getActiveAtsRuleset } from '@/lib/cms-fast/ats';
import { getCache } from '@/lib/cache';
import { v1Route, v1Ok } from '@/lib/integrations/http';
import { apiError } from '@/lib/integrations/http';

// Recognised platform slugs — reject anything else fast, before a DB read.
const PLATFORMS = new Set([
  'greenhouse',
  'lever',
  'workday',
  'workable',
  'taleo',
  'ashby',
  'smartrecruiters',
  'icims',
  'linkedin',
]);

export const GET = v1Route('read', async (context) => {
  // The dynamic segment: /api/v1/ats-rulesets/{platform}
  const platform = decodeURIComponent(context.url.pathname.split('/').filter(Boolean).pop() ?? '')
    .toLowerCase()
    .trim();

  if (!PLATFORMS.has(platform)) {
    return apiError(
      'not_found',
      `Unknown ATS platform "${platform}". Supported: ${[...PLATFORMS].join(', ')}.`,
      404,
    );
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
      // Surfaced so the engine can log/alert on slow or uncached reads.
      cacheBackend: getCache().backend,
      lookupMs,
    },
  });
});
