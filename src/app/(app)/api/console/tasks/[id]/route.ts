import { z } from 'zod';
import { fail, ok } from '@/lib/api';
import { consoleRoute, requireStaff } from '@/lib/crm/auth';
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  listStaffQueue,
  updateTask,
} from '@/lib/crm/activities';

type Params = { params: Promise<{ id: string }> };

const patchSchema = z
  .object({
    status: z.enum(TASK_STATUSES).optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    dueAt: z.string().datetime().nullable().optional(),
    assigneeStaffId: z.string().max(40).nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update.' });

/**
 * PATCH /api/console/tasks/:id — move a task on, reassign it or reschedule it.
 *
 * `:id` is the CrmTask id, not a customer id. Any staff member may work any
 * task: a queue only one person can touch stops being a queue the moment they
 * take a holiday.
 */
export const PATCH = consoleRoute(async (request: Request, { params }: Params) => {
  const staff = await requireStaff('support');
  const { id } = await params;
  const body = patchSchema.parse(await request.json());

  const task = await updateTask(
    id,
    {
      status: body.status,
      priority: body.priority,
      title: body.title,
      description: body.description,
      dueAt: body.dueAt === undefined ? undefined : body.dueAt ? new Date(body.dueAt) : null,
      assigneeStaffId: body.assigneeStaffId,
    },
    staff,
  );

  if (!task) return fail('Task not found.', 404);
  return ok({ task });
});

/**
 * GET /api/console/tasks/queue — the signed-in staff member's open work.
 *
 * Served from this file with the literal id "queue" so the console has a
 * single-word URL for the view it opens on. A real task id never collides:
 * ids are cuids, which always start with "c" and are 25 characters.
 */
export const GET = consoleRoute(async (_request: Request, { params }: Params) => {
  const staff = await requireStaff('support');
  const { id } = await params;
  if (id !== 'queue') return fail('Not found.', 404);
  return ok({ tasks: await listStaffQueue(staff.id) });
});
