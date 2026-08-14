import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { describeWait, fail, route, tooMany } from '@/lib/api';
import { buildJobMatchesExport } from '@/lib/exports/builders';
import { parseExportRange, rangeProblem } from '@/lib/exports/range';
import { EXPORT_RATE_LIMIT, exportFormatSchema, exportResponse } from '@/lib/exports/response';
import { rateLimit } from '@/lib/rate-limit';

const query = z.object({
  format: exportFormatSchema('csv'),
  from: z.string().optional(),
  to: z.string().optional(),
});

/**
 * Download the postings the user's agents matched, as CSV or PDF.
 *
 * GET /api/exports/matches?format=csv|pdf&from=&to=
 *
 * Matches belong to an agent rather than directly to a user, so ownership is
 * enforced through the agent relation — see `buildJobMatchesExport`. The CSV
 * carries the matched and missing keywords, which is the column people
 * actually export this for.
 */
export const GET = route(async (request: Request) => {
  const user = await requireUser();

  const limit = rateLimit('export', user.id, EXPORT_RATE_LIMIT);
  if (!limit.ok) {
    return tooMany(
      `That is a lot of exports at once. Try again in ${describeWait(limit.retryAfterSeconds)}.`,
      limit.retryAfterSeconds,
    );
  }

  const params = query.parse(Object.fromEntries(new URL(request.url).searchParams));
  const range = parseExportRange(params);
  const problem = rangeProblem(params, range);
  if (problem) return fail(problem, 422);

  const dataset = await buildJobMatchesExport(user.id, { range });
  return exportResponse(dataset, params.format);
});
