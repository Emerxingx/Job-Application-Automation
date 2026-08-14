import { z } from 'zod';
import { db } from '@/lib/db';
import { fail, ok } from '@/lib/api';
import { consoleRoute, requireStaff } from '@/lib/crm/auth';
import { TASK_PRIORITIES, createTask, listTasks } from '@/lib/crm/activities';

type Params = { params: Promise<{ id: string }> };

/** GET /api/console/customers/:id/tasks — open work by default, `?closed=1` for all. */
export const GET = consoleRoute(async (request: Request, { params }: Params) => {
  await requireStaff('support');
  const { id } = await params;
  const includeClosed = new URL(request.url).searchParams.get('closed') === '1';
  return ok({ tasks: await listTasks(id, { includeClosed }) });
});

const createSchema = z.object({
  title: z.string().trim().min(1, 'A task needs a title.').max(200),
  description: z.string().max(2000).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  dueAt: z.string().datetime().nullable().optional(),
  /** Omit to keep it yourself. */
  assigneeStaffId: z.string().max(40).nullable().optional(),
});

/** POST /api/console/customers/:id/tasks — create a follow-up. */
export const POST = consoleRoute(async (request: Request, { params }: Params) => {
  const staff = await requireStaff('support');
  const { id } = await params;
  const body = createSchema.parse(await request.json());

  const user = await db.user.findUnique({ where: { id }, select: { id: true } });
  if (!user) return fail('Customer not found.', 404);

  const task = await createTask({
    userId: id,
    staff,
    title: body.title,
    description: body.description,
    priority: body.priority,
    dueAt: body.dueAt ? new Date(body.dueAt) : null,
    assigneeStaffId: body.assigneeStaffId,
  });

  return ok({ task }, { status: 201 });
});
