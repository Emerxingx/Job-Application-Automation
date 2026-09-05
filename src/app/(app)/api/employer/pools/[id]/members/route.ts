import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { employerDone, employerFail, employerRequest } from '@/lib/employer/request';
import { addToPool } from '@/lib/employer/service';

const schema = z.object({ organizationId: z.string().min(1), candidateUserId: z.string().min(1) });

/** POST /api/employer/pools/:id/members - add a candidate who GRANTED disclosure; the membership cites the disclosure and goes with its revocation. */
export const POST = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = schema.parse(await request.json());
  try {
    const { tenant, actor } = await employerRequest(request, body.organizationId);
    const m = await employerDone(actor, () => tenant.run((tx) => addToPool(tx, actor, id, body.candidateUserId)));
    return ok({ member: { id: m.id } }, { status: 201 });
  } catch (error) {
    return employerFail(error) ?? Promise.reject(error);
  }
});
