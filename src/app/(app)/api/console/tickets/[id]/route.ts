import { z } from 'zod';
import { fail, ok } from '@/lib/api';
import { consoleRoute, requireStaff } from '@/lib/crm/auth';
import {
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  getTicket,
  updateTicket,
} from '@/lib/crm/tickets';

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/console/tickets/:id — the full thread.
 *
 * Messages come back with `internal` intact; internal notes are staff-only and
 * anything rendering this outside the console must filter them out.
 */
export const GET = consoleRoute(async (_request: Request, { params }: Params) => {
  await requireStaff('support');
  const { id } = await params;

  const ticket = await getTicket(id);
  if (!ticket) return fail('Ticket not found.', 404);
  return ok({ ticket });
});

const patchSchema = z
  .object({
    status: z.enum(TICKET_STATUSES).optional(),
    priority: z.enum(TICKET_PRIORITIES).optional(),
    category: z.enum(TICKET_CATEGORIES).optional(),
    /** Null unassigns; omitted leaves the assignee alone. */
    assigneeStaffId: z.string().max(40).nullable().optional(),
    tags: z.array(z.string().max(40)).max(20).optional(),
    subject: z.string().trim().min(1).max(200).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update.' });

/** PATCH /api/console/tickets/:id — triage: assign, reprioritise, resolve. */
export const PATCH = consoleRoute(async (request: Request, { params }: Params) => {
  const staff = await requireStaff('support');
  const { id } = await params;
  const body = patchSchema.parse(await request.json());

  const ticket = await updateTicket(id, body, staff);
  if (!ticket) return fail('Ticket not found.', 404);
  return ok({ ticket });
});
