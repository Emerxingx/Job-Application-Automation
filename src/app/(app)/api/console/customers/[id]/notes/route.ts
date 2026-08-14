import { z } from 'zod';
import { db } from '@/lib/db';
import { fail, ok } from '@/lib/api';
import { consoleRoute, requireStaff } from '@/lib/crm/auth';
import { addNote, listNotes } from '@/lib/crm/activities';

type Params = { params: Promise<{ id: string }> };

/** GET /api/console/customers/:id/notes — pinned first, then newest first. */
export const GET = consoleRoute(async (_request: Request, { params }: Params) => {
  await requireStaff('support');
  const { id } = await params;
  return ok({ notes: await listNotes(id) });
});

const createSchema = z.object({
  body: z.string().trim().min(1, 'A note needs some text.').max(4000),
  pinned: z.boolean().optional().default(false),
});

/**
 * POST /api/console/customers/:id/notes — add a staff note.
 *
 * The user is checked before the note is written so a typo'd id creates a
 * Customer shell for nobody.
 */
export const POST = consoleRoute(async (request: Request, { params }: Params) => {
  const staff = await requireStaff('support');
  const { id } = await params;
  const body = createSchema.parse(await request.json());

  const user = await db.user.findUnique({ where: { id }, select: { id: true } });
  if (!user) return fail('Customer not found.', 404);

  const note = await addNote(id, staff, body.body, body.pinned);
  return ok({ note }, { status: 201 });
});
