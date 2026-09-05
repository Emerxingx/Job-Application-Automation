import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { employerFail, employerRequest } from '@/lib/employer/request';
import { decideOffer } from '@/lib/employer/service';

const schema = z.object({ organizationId: z.string().min(1), status: z.enum(['accepted', 'declined', 'withdrawn']), fillRequisition: z.boolean().optional() });

/** PATCH /api/employer/offers/:id - record the candidate's answer or withdraw; accepted is a hire (optionally filling the requisition, which closes the posting). */
export const PATCH = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = schema.parse(await request.json());
  try {
    const { tenant, actor } = await employerRequest(request, body.organizationId);
    const o = await tenant.run((tx) => decideOffer(tx, actor, id, body));
    return ok({ offer: { id: o.id, status: o.status } });
  } catch (error) {
    return employerFail(error) ?? Promise.reject(error);
  }
});
