import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { employerFail, employerRequest } from '@/lib/employer/request';
import { scheduleInterview } from '@/lib/employer/service';

const schema = z.object({ organizationId: z.string().min(1), kind: z.string().trim().max(40).optional(), scheduledAt: z.coerce.date(), durationMinutes: z.number().int().min(5).max(480).nullable().optional(), interviewerIds: z.array(z.string().min(1)).max(10).optional() });

/** POST /api/employer/submissions/:id/interviews - schedule an interview (disclosed candidates only); the submission moves to `interviewing`. */
export const POST = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = schema.parse(await request.json());
  try {
    const { tenant, actor } = await employerRequest(request, body.organizationId);
    const i = await tenant.run((tx) => scheduleInterview(tx, actor, id, body));
    return ok({ interview: { id: i.id, scheduledAt: i.scheduledAt } }, { status: 201 });
  } catch (error) {
    return employerFail(error) ?? Promise.reject(error);
  }
});
