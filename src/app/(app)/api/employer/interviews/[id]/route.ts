import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { employerFail, employerRequest } from '@/lib/employer/request';
import { INTERVIEW_OUTCOMES, recordInterview } from '@/lib/employer/service';

const schema = z.object({ organizationId: z.string().min(1), outcome: z.enum(INTERVIEW_OUTCOMES), feedback: z.string().trim().max(5000).optional() });

/** PATCH /api/employer/interviews/:id - a named interviewer or the pipeline's owner records the outcome and feedback. */
export const PATCH = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = schema.parse(await request.json());
  try {
    const { tenant, actor } = await employerRequest(request, body.organizationId);
    const i = await tenant.run((tx) => recordInterview(tx, actor, id, body));
    return ok({ interview: { id: i.id, outcome: i.outcome } });
  } catch (error) {
    return employerFail(error) ?? Promise.reject(error);
  }
});
