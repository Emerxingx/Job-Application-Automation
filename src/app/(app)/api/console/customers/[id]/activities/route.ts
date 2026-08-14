import { z } from 'zod';
import { db } from '@/lib/db';
import { fail, ok } from '@/lib/api';
import { consoleRoute, requireStaff } from '@/lib/crm/auth';
import {
  CRM_ACTIVITY_TYPES,
  CRM_DIRECTIONS,
  getCustomerTimeline,
  isTimelineSource,
  logActivity,
} from '@/lib/crm/activities';

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/console/customers/:id/activities — the merged timeline.
 *
 * `?sources=crm,product` narrows it; `?limit=` caps it. Entries carry
 * `visibility`, and anything marked `internal` is staff-only — a client
 * rendering this to a customer must filter on that field.
 */
export const GET = consoleRoute(async (request: Request, { params }: Params) => {
  await requireStaff('support');
  const { id } = await params;

  const url = new URL(request.url);
  const rawSources = (url.searchParams.get('sources') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter(isTimelineSource);
  const limit = Number(url.searchParams.get('limit') ?? '100');

  const timeline = await getCustomerTimeline(id, {
    sources: rawSources.length ? rawSources : undefined,
    limit: Number.isFinite(limit) ? limit : 100,
  });

  return ok({ timeline });
});

const logSchema = z.object({
  type: z.enum(CRM_ACTIVITY_TYPES),
  direction: z.enum(CRM_DIRECTIONS).optional(),
  subject: z.string().trim().min(1, 'Give the entry a subject.').max(200),
  body: z.string().max(4000).optional(),
  occurredAt: z.string().datetime().optional(),
  relatedTicketId: z.string().max(40).nullable().optional(),
  relatedInvoiceId: z.string().max(40).nullable().optional(),
});

/**
 * POST /api/console/customers/:id/activities — log a call, email or meeting.
 *
 * Append-only: there is no PATCH or DELETE here, deliberately. An editable
 * contact history is not a contact history.
 */
export const POST = consoleRoute(async (request: Request, { params }: Params) => {
  const staff = await requireStaff('support');
  const { id } = await params;
  const body = logSchema.parse(await request.json());

  const user = await db.user.findUnique({ where: { id }, select: { id: true } });
  if (!user) return fail('Customer not found.', 404);

  const activity = await logActivity({
    userId: id,
    staff,
    type: body.type,
    direction: body.direction,
    subject: body.subject,
    body: body.body,
    relatedTicketId: body.relatedTicketId ?? null,
    relatedInvoiceId: body.relatedInvoiceId ?? null,
    occurredAt: body.occurredAt ? new Date(body.occurredAt) : undefined,
  });

  return ok({ activity }, { status: 201 });
});
