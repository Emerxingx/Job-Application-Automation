import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { employerFail, employerRequest } from '@/lib/employer/request';
import { addSubmission } from '@/lib/employer/service';

const schema = z.object({ organizationId: z.string().min(1), candidateUserId: z.string().min(1), source: z.enum(['sourced', 'pool', 'referred']).optional() });

/** POST /api/employer/requisitions/:id/submissions - put a sourced candidate into the pipeline (at `sourced` until they grant disclosure). */
export const POST = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = schema.parse(await request.json());
  try {
    const { tenant, actor } = await employerRequest(request, body.organizationId);
    const s = await tenant.run((tx) => addSubmission(tx, actor, id, body.candidateUserId, body.source));
    return ok({ submission: { id: s.id, stage: s.stage } }, { status: 201 });
  } catch (error) {
    return employerFail(error) ?? Promise.reject(error);
  }
});
