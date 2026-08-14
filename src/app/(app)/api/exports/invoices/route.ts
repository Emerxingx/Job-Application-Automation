import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { describeWait, fail, route, tooMany } from '@/lib/api';
import { buildInvoicesExport } from '@/lib/exports/builders';
import { parseExportRange, rangeProblem } from '@/lib/exports/range';
import { EXPORT_RATE_LIMIT, exportFormatSchema, exportResponse } from '@/lib/exports/response';
import { rateLimit } from '@/lib/rate-limit';

const query = z.object({
  format: exportFormatSchema('csv'),
  from: z.string().optional(),
  to: z.string().optional(),
});

/**
 * Download the signed-in user's invoices as CSV or PDF.
 *
 * GET /api/exports/invoices?format=csv|pdf[&from=&to=]
 *
 * This is the bookkeeping summary of every issued invoice — the per-invoice
 * document with its frozen tax lines stays at /api/invoices/:id/pdf, which is
 * the one to send an accountant. Drafts are excluded here for the same reason
 * they are excluded there: an unissued invoice is not a document the customer
 * has been given.
 *
 * `from` / `to` are optional and filter on the issue date; the filename always
 * states the window either way.
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

  const dataset = await buildInvoicesExport(user.id, { range });
  return exportResponse(dataset, params.format);
});
