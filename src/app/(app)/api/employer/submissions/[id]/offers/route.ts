import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { employerFail, employerRequest } from '@/lib/employer/request';
import { extendOffer } from '@/lib/employer/service';

const schema = z.object({ organizationId: z.string().min(1), salaryCents: z.number().int().min(0).nullable().optional(), currency: z.enum(['CAD', 'USD']).optional(), startDate: z.coerce.date().nullable().optional(), note: z.string().trim().max(2000).optional() });

/** POST /api/employer/submissions/:id/offers - extend an offer (recruiter, the hiring manager, admin; disclosed candidates only); the submission moves to `offered`. */
export const POST = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = schema.parse(await request.json());
  try {
    const { tenant, actor } = await employerRequest(request, body.organizationId);
    const o = await tenant.run((tx) => extendOffer(tx, actor, id, body));
    return ok({ offer: { id: o.id, status: o.status } }, { status: 201 });
  } catch (error) {
    return employerFail(error) ?? Promise.reject(error);
  }
});
