import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { employerFail, employerRequest, organizationIdOf } from '@/lib/employer/request';
import { createRequisition, listRequisitions } from '@/lib/employer/service';
import { requisitionSchema } from '@/lib/employer/schemas';

/** GET /api/employer/requisitions?organizationId= - the organisation's requisitions (Stage 18, ADR-0033). */
export const GET = route(async (request: Request) => {
  try {
    const { tenant, actor } = await employerRequest(request, organizationIdOf(request));
    const rows = await tenant.run((tx) => listRequisitions(tx, actor));
    return ok({ role: actor.role, requisitions: rows.map((r) => ({ id: r.id, title: r.title, status: r.status, location: r.location, jobId: r.jobId, submissions: r._count.submissions, openedAt: r.openedAt, updatedAt: r.updatedAt })) });
  } catch (error) {
    return employerFail(error) ?? Promise.reject(error);
  }
});


/** POST /api/employer/requisitions - create a draft requisition (recruiter, hiring manager, admin). Nothing is published until it is opened. */
export const POST = route(async (request: Request) => {
  const body = requisitionSchema.extend({ organizationId: z.string().min(1) }).parse(await request.json());
  try {
    const { tenant, actor } = await employerRequest(request, body.organizationId);
    const { organizationId: _o, ...input } = body;
    void _o;
    const r = await tenant.run((tx) => createRequisition(tx, actor, input));
    return ok({ requisition: { id: r.id, status: r.status } }, { status: 201 });
  } catch (error) {
    return employerFail(error) ?? Promise.reject(error);
  }
});
