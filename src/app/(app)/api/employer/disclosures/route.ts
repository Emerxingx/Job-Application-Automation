import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { employerDone, employerFail, employerRequest } from '@/lib/employer/request';
import { requestDisclosure } from '@/lib/employer/service';

const schema = z.object({ organizationId: z.string().min(1), candidateUserId: z.string().min(1), requisitionId: z.string().min(1).nullable().optional(), message: z.string().trim().max(500).optional() });

/** POST /api/employer/disclosures - ask a candidate to disclose their identity to this organisation (recruiter, admin). The candidate answers under Settings. */
export const POST = route(async (request: Request) => {
  const body = schema.parse(await request.json());
  try {
    const { actor } = await employerRequest(request, body.organizationId);
    const d = await employerDone(actor, () => requestDisclosure(actor, body));
    return ok({ disclosure: { id: d.id, status: d.status } }, { status: 201 });
  } catch (error) {
    return employerFail(error) ?? Promise.reject(error);
  }
});
