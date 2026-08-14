import { z } from 'zod';
import { fail, ok } from '@/lib/api';
import { consoleRoute, requireStaff } from '@/lib/crm/auth';
import { TICKET_STATUSES, replyToTicket } from '@/lib/crm/tickets';

type Params = { params: Promise<{ id: string }> };

const replySchema = z.object({
  body: z.string().trim().min(1, 'Write something before sending.').max(8000),
  /**
   * True files a staff-only note in the same thread. It does NOT stop the
   * first-response clock and it is never shown to the customer.
   */
  internal: z.boolean().optional().default(false),
  /** Optionally move the ticket on in the same action. */
  status: z.enum(TICKET_STATUSES).optional(),
});

/**
 * POST /api/console/tickets/:id/messages — reply, or add an internal note.
 *
 * The first public reply is what stamps firstResponseAt and decides
 * breachedSla, once, for good.
 */
export const POST = consoleRoute(async (request: Request, { params }: Params) => {
  const staff = await requireStaff('support');
  const { id } = await params;
  const body = replySchema.parse(await request.json());

  const ticket = await replyToTicket({
    ticketId: id,
    staff,
    body: body.body,
    internal: body.internal,
    status: body.status,
  });

  if (!ticket) return fail('Ticket not found.', 404);
  return ok({ ticket }, { status: 201 });
});
