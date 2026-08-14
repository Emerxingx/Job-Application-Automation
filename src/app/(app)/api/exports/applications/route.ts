import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { describeWait, fail, route, tooMany } from '@/lib/api';
import { buildApplicationsExport } from '@/lib/exports/builders';
import { parseExportRange, rangeProblem } from '@/lib/exports/range';
import { EXPORT_RATE_LIMIT, exportFormatSchema, exportResponse } from '@/lib/exports/response';
import { rateLimit } from '@/lib/rate-limit';

const query = z.object({
  format: exportFormatSchema('csv'),
  from: z.string().optional(),
  to: z.string().optional(),
});

/**
 * Download the signed-in user's applications as CSV or PDF.
 *
 * GET /api/exports/applications?format=csv|pdf&from=2026-01-01&to=2026-08-14
 *
 * The window is inclusive of both days and matches on the date the application
 * went out, falling back to the date it was created for ones that never did.
 * Scoping is not a filter the caller can influence: the builder takes the user
 * id from the session and every query is keyed on it.
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

  const dataset = await buildApplicationsExport(user.id, { range });
  return exportResponse(dataset, params.format);
});
