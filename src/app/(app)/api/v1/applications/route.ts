/**
 * GET /api/v1/applications — the caller's applications, newest first.
 *
 * Authenticated by API KEY, not by the session cookie:
 *
 *     curl https://jobpilot.ai/api/v1/applications?status=submitted&limit=50 \
 *       -H "Authorization: Bearer jp_live_8f3a2b1c_…"
 *
 * Query parameters
 *   status    one of the application statuses (queued, submitted, offer, …)
 *   agentId   restrict to applications created by one agent
 *   since     ISO-8601; applications created at or after this instant
 *   until     ISO-8601; applications created at or before this instant
 *   limit     1–100, default 25
 *   offset    0–100000, default 0
 *
 * An unknown parameter is IGNORED rather than rejected. Rejecting would break
 * every client the day we add a parameter their SDK started sending, and the
 * failure mode of ignoring one is a caller seeing unfiltered results — visible
 * immediately, unlike a 400 that only fires on some deploys.
 */

import { PUBLIC_APPLICATION_STATUSES, listApplicationsForApi } from '@/lib/integrations/public-api';
import {
  listEnvelope,
  parseDateParam,
  parseEnumParam,
  parsePagination,
  v1Ok,
  v1Route,
} from '@/lib/integrations/http';

export const GET = v1Route('read', async (context) => {
  const pagination = parsePagination(context.url);
  const agentId = context.url.searchParams.get('agentId')?.trim() || undefined;

  const { data, total } = await listApplicationsForApi(
    context.key.userId,
    {
      status: parseEnumParam(context.url, 'status', PUBLIC_APPLICATION_STATUSES),
      agentId,
      since: parseDateParam(context.url, 'since'),
      until: parseDateParam(context.url, 'until'),
    },
    pagination,
  );

  return v1Ok(context, listEnvelope(data, pagination, total));
});
