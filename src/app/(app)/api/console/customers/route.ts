import { z } from 'zod';
import { describeWait, ok, tooMany } from '@/lib/api';
import { rateLimit } from '@/lib/rate-limit';
import { consoleRoute, requireStaff } from '@/lib/crm/auth';
import {
  isCustomerSort,
  listCustomers,
  parseRiskFilter,
  parseStageFilter,
} from '@/lib/crm/customers';

/**
 * Reading the customer book is the console's bulk-PII surface, so it carries
 * its own ceiling on top of the staff gate. Generous for a person clicking
 * through pages; a hard stop for a script paging the whole database.
 */
const LIST_LIMIT = { limit: 240, windowSeconds: 300 };

/**
 * Accepts a plain date ("2026-01-01") as well as a full timestamp — a date
 * picker sends the short form and a 422 for it would just look broken.
 */
const dateParam = z
  .string()
  .max(40)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Not a valid date.');

const querySchema = z.object({
  search: z.string().max(120).optional(),
  plan: z.string().max(40).optional(),
  owner: z.string().max(40).optional(),
  segment: z.string().max(40).optional(),
  vip: z.enum(['true', 'false']).optional(),
  signedUpAfter: dateParam.optional(),
  signedUpBefore: dateParam.optional(),
  minMrrCents: z.coerce.number().int().min(0).max(100_000_00).optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

/** GET /api/console/customers — search, filter, sort and page the book. */
export const GET = consoleRoute(async (request: Request) => {
  const staff = await requireStaff('support');

  const limit = await rateLimit('console-customers', staff.id, LIST_LIMIT);
  if (!limit.ok) {
    return tooMany(
      `Too many console queries. Try again in ${describeWait(limit.retryAfterSeconds)}.`,
      limit.retryAfterSeconds,
    );
  }

  const url = new URL(request.url);
  const raw = Object.fromEntries(url.searchParams.entries());
  const query = querySchema.parse(raw);
  const sortParam = url.searchParams.get('sort');

  const result = await listCustomers({
    search: query.search,
    stage: parseStageFilter(url.searchParams.get('stage')),
    risk: parseRiskFilter(url.searchParams.get('risk')),
    planCode: query.plan,
    ownerStaffId: query.owner,
    segment: query.segment,
    vip: query.vip === undefined ? undefined : query.vip === 'true',
    signedUpAfter: query.signedUpAfter ? new Date(query.signedUpAfter) : undefined,
    signedUpBefore: query.signedUpBefore ? new Date(query.signedUpBefore) : undefined,
    minMrrCents: query.minMrrCents,
    sort: sortParam && isCustomerSort(sortParam) ? sortParam : undefined,
    page: query.page,
    pageSize: query.pageSize,
  });

  return ok(result);
});
