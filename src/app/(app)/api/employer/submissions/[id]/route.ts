import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { employerFail, employerRequest, organizationIdOf } from '@/lib/employer/request';
import { loadSubmission, moveSubmission } from '@/lib/employer/service';
import { SUBMISSION_STAGES } from '@/lib/employer/stage-machine';

type Params = { params: Promise<{ id: string }> };

/** GET /api/employer/submissions/:id?organizationId= - one submission with its events, interviews, notes and offers. */
export const GET = route(async (request: Request, { params }: Params) => {
  const { id } = await params;
  try {
    const { tenant, actor } = await employerRequest(request, organizationIdOf(request));
    return ok(await tenant.run((tx) => loadSubmission(tx, actor, id)));
  } catch (error) {
    return employerFail(error) ?? Promise.reject(error);
  }
});

const schema = z.object({ organizationId: z.string().min(1), to: z.enum(SUBMISSION_STAGES), note: z.string().trim().max(500).optional() });

/** PATCH /api/employer/submissions/:id - move through the stage machine; a disclosed stage needs the candidate's granted disclosure. */
export const PATCH = route(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const body = schema.parse(await request.json());
  try {
    const { tenant, actor } = await employerRequest(request, body.organizationId);
    const s = await tenant.run((tx) => moveSubmission(tx, actor, id, body.to, body.note));
    return ok({ submission: { id: s.id, stage: s.stage } });
  } catch (error) {
    return employerFail(error) ?? Promise.reject(error);
  }
});
