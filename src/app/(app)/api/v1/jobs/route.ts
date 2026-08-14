/**
 * GET /api/v1/jobs — jobs the caller's agents matched, best score first.
 *
 *     curl "https://jobpilot.ai/api/v1/jobs?minScore=80&status=new" \
 *       -H "Authorization: Bearer jp_live_8f3a2b1c_…"
 *
 * Query parameters
 *   agentId   restrict to one agent's matches
 *   status    match status: new, reviewed, queued, applied, dismissed
 *   minScore  0–100; only matches at or above this score
 *   country   CA or US
 *   workMode  onsite, hybrid or remote
 *   since     ISO-8601; matches found at or after this instant
 *   limit     1–100, default 25
 *   offset    0–100000, default 0
 *
 * There is no unscoped job search here. `Job` rows are shared across every
 * customer — one agent's discovery populates the table for everyone — so an
 * endpoint that listed jobs without going through the caller's agents would let
 * any key enumerate what other customers are hunting for. Ownership is
 * established through `JobMatch.agent.userId` and nowhere else.
 */

import { PUBLIC_MATCH_STATUSES, listJobsForApi } from '@/lib/integrations/public-api';
import {
  listEnvelope,
  parseBoundedInt,
  parseDateParam,
  parseEnumParam,
  parsePagination,
  v1Ok,
  v1Route,
} from '@/lib/integrations/http';

const COUNTRIES = ['CA', 'US'] as const;
const WORK_MODES = ['onsite', 'hybrid', 'remote'] as const;

export const GET = v1Route('read', async (context) => {
  const pagination = parsePagination(context.url);
  const rawMinScore = context.url.searchParams.get('minScore');
  const agentId = context.url.searchParams.get('agentId')?.trim() || undefined;

  const { data, total } = await listJobsForApi(
    context.key.userId,
    {
      agentId,
      status: parseEnumParam(context.url, 'status', PUBLIC_MATCH_STATUSES),
      // `undefined` rather than 0 when absent: a `matchScore >= 0` filter is a
      // no-op but still forces the query planner down a range scan.
      minScore:
        rawMinScore === null || rawMinScore.trim() === ''
          ? undefined
          : parseBoundedInt(rawMinScore, { fallback: 0, min: 0, max: 100, param: 'minScore' }),
      country: parseEnumParam(context.url, 'country', COUNTRIES),
      workMode: parseEnumParam(context.url, 'workMode', WORK_MODES),
      since: parseDateParam(context.url, 'since'),
    },
    pagination,
  );

  return v1Ok(context, listEnvelope(data, pagination, total));
});
