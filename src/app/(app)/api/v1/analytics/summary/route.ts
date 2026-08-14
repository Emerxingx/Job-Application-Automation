/**
 * GET /api/v1/analytics/summary — the whole dashboard in one request.
 *
 *     curl "https://jobpilot.ai/api/v1/analytics/summary?since=2026-01-01" \
 *       -H "Authorization: Bearer jp_live_8f3a2b1c_…"
 *
 * Query parameters
 *   since   ISO-8601, start of the reporting window. Default: 30 days ago.
 *   until   ISO-8601, end of the window. Default: now.
 *
 * The window applies to the `windowed` block only. `lifetime`, `byStatus`,
 * `rates` and `scores` cover the whole account on purpose — a conversion rate
 * computed over four days of data is noise, and an API that let a caller
 * accidentally ask for that would mostly be used to produce it.
 *
 * Rates are integer PARTS PER MILLION (1,000,000 = 100%), matching the house
 * convention. Divide by 10,000 for a percentage.
 *
 * This endpoint is safe to poll: it performs no writes. See the note in
 * `buildAnalyticsSummary` about deliberately not calling `getQuota()`, which
 * rolls the billing period forward as a side effect.
 */

import { buildAnalyticsSummary } from '@/lib/integrations/public-api';
import { badRequest, parseDateParam, v1Ok, v1Route } from '@/lib/integrations/http';

export const GET = v1Route('read', async (context) => {
  const since = parseDateParam(context.url, 'since');
  const until = parseDateParam(context.url, 'until');

  if (since && until && since > until) {
    throw badRequest('`since` must be earlier than `until`.', 'since');
  }

  const summary = await buildAnalyticsSummary(context.key.userId, { since, until });
  return v1Ok(context, summary);
});
