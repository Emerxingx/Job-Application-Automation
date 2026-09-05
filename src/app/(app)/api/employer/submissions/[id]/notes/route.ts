import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { employerDone, employerFail, employerRequest } from '@/lib/employer/request';
import { addEmployerNote } from '@/lib/employer/service';

const schema = z.object({ organizationId: z.string().min(1), body: z.string().trim().min(1).max(5000) });

/** POST /api/employer/submissions/:id/notes - a hiring-team note on a submission (the employer's own record; never shown to the candidate). */
export const POST = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = schema.parse(await request.json());
  try {
    const { tenant, actor } = await employerRequest(request, body.organizationId);
    const n = await employerDone(actor, () => tenant.run((tx) => addEmployerNote(tx, actor, id, body.body)));
    return ok({ note: { id: n.id } }, { status: 201 });
  } catch (error) {
    return employerFail(error) ?? Promise.reject(error);
  }
});
