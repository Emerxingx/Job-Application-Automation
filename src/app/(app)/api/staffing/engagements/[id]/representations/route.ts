import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { staffingFail, staffingRequest } from '@/lib/staffing/request';
import { requestRepresentation } from '@/lib/staffing/service';

const schema = z.object({ organizationId: z.string().min(1), email: z.string().email(), message: z.string().trim().max(500).optional() });

/** POST /api/staffing/engagements/:id/representations - ask a person, by email, to be represented for this engagement. The answer is the same whether or not an account exists. */
export const POST = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = schema.parse(await request.json());
  try {
    const { actor } = await staffingRequest(request, body.organizationId);
    const r = await requestRepresentation(actor, { engagementId: id, email: body.email, message: body.message });
    return ok({ representation: { id: r.id, status: r.status } }, { status: 201 });
  } catch (error) {
    return staffingFail(error) ?? Promise.reject(error);
  }
});
