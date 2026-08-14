import { z } from 'zod';
import { db } from '@/lib/db';
import { fail, ok } from '@/lib/api';
import { consoleRoute, requireStaff } from '@/lib/crm/auth';
import {
  TICKET_CATEGORIES,
  TICKET_CHANNELS,
  TICKET_PRIORITIES,
  createTicket,
  isTicketCategory,
  isTicketPriority,
  isTicketStatus,
  listTickets,
} from '@/lib/crm/tickets';

/**
 * GET /api/console/tickets — the support queue.
 *
 * Defaults to work in progress (open, pending, on_hold) rather than every
 * ticket ever filed; pass `?status=` for one state or `?all=1` for the lot.
 * SLA-breached tickets sort to the top.
 */
export const GET = consoleRoute(async (request: Request) => {
  await requireStaff('support');
  const url = new URL(request.url);
  const params = url.searchParams;

  const status = params.get('status');
  const priority = params.get('priority');
  const category = params.get('category');
  const breached = params.get('breached');
  // "none" is the unassigned queue, not a staff id.
  const assignee = params.get('assignee');

  const result = await listTickets({
    status: status && isTicketStatus(status) ? status : undefined,
    openOnly: !status && params.get('all') !== '1',
    priority: priority && isTicketPriority(priority) ? priority : undefined,
    category: category && isTicketCategory(category) ? category : undefined,
    assigneeStaffId: assignee && assignee !== 'none' ? assignee : undefined,
    unassigned: assignee === 'none' ? true : undefined,
    userId: params.get('userId') ?? undefined,
    breachedSla: breached === null ? undefined : breached === '1',
    search: params.get('search') ?? undefined,
    page: Number(params.get('page') ?? '1') || 1,
    pageSize: Number(params.get('pageSize') ?? '25') || 25,
  });

  return ok(result);
});

const createSchema = z.object({
  /** Omit for someone who is not a registered user; the schema allows that. */
  userId: z.string().max(40).nullable().optional(),
  email: z.string().email('A valid email is required.').max(200),
  subject: z.string().trim().min(1, 'Give the ticket a subject.').max(200),
  body: z.string().trim().min(1, 'Describe the problem.').max(8000),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  category: z.enum(TICKET_CATEGORIES).optional(),
  channel: z.enum(TICKET_CHANNELS).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  relatedApplicationId: z.string().max(40).nullable().optional(),
  relatedAgentId: z.string().max(40).nullable().optional(),
});

/**
 * POST /api/console/tickets — raise a ticket on a customer's behalf.
 *
 * The opening message is recorded as the CUSTOMER's, not the staff member's:
 * the complaint belongs to them, and attributing it to staff would count as a
 * first response and quietly zero the SLA on a ticket nobody has answered.
 */
export const POST = consoleRoute(async (request: Request) => {
  const staff = await requireStaff('support');
  const body = createSchema.parse(await request.json());

  if (body.userId) {
    const user = await db.user.findUnique({ where: { id: body.userId }, select: { id: true } });
    if (!user) return fail('That customer does not exist.', 404);
  }

  const ticket = await createTicket({
    userId: body.userId ?? null,
    email: body.email,
    subject: body.subject,
    body: body.body,
    priority: body.priority,
    category: body.category,
    channel: body.channel,
    tags: body.tags,
    relatedApplicationId: body.relatedApplicationId ?? null,
    relatedAgentId: body.relatedAgentId ?? null,
    staff,
  });

  return ok({ ticket }, { status: 201 });
});
