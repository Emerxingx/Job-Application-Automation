import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { describeWait, fail, route, tooMany } from '@/lib/api';
import { buildAnalyticsExport } from '@/lib/exports/builders';
import { parseExportRange, rangeProblem } from '@/lib/exports/range';
import { EXPORT_RATE_LIMIT, exportFormatSchema, exportResponse } from '@/lib/exports/response';
import { rateLimit } from '@/lib/rate-limit';

const query = z.object({
  // A summary report is something you print or email, so PDF is the default
  // here — the other two exports default to CSV because they are data.
  format: exportFormatSchema('pdf'),
  from: z.string().optional(),
  to: z.string().optional(),
});

/**
 * Download a job-search analytics summary.
 *
 * GET /api/exports/analytics?format=pdf|csv&from=2026-01-01&to=2026-08-14
 *
 * Funnel counts, conversion rates, match quality, a status breakdown, the
 * companies applied to most, monthly activity and a billing total — all
 * computed from this user's rows only.
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

  const dataset = await buildAnalyticsExport(user.id, { range });
  return exportResponse(dataset, params.format);
});
