import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { employerFail, employerRequest, organizationIdOf } from '@/lib/employer/request';
import { REQUISITION_STATUSES, loadRequisition, setRequisitionStatus, updateRequisition } from '@/lib/employer/service';
import { requisitionSchema } from '@/lib/employer/schemas';

type Params = { params: Promise<{ id: string }> };

/** GET /api/employer/requisitions/:id?organizationId= - the requisition and its pipeline (identity only for disclosed candidates). */
export const GET = route(async (request: Request, { params }: Params) => {
  const { id } = await params;
  try {
    const { tenant, actor } = await employerRequest(request, organizationIdOf(request));
    return ok(await tenant.run((tx) => loadRequisition(tx, actor, id)));
  } catch (error) {
    return employerFail(error) ?? Promise.reject(error);
  }
});

const patchSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('update'), organizationId: z.string().min(1), input: requisitionSchema.partial() }),
  z.object({ action: z.literal('status'), organizationId: z.string().min(1), status: z.enum(REQUISITION_STATUSES) }),
]);

/** PATCH /api/employer/requisitions/:id - edit (re-published if open) or move the status (opening publishes through the connector gate). */
export const PATCH = route(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const body = patchSchema.parse(await request.json());
  try {
    const { tenant, actor } = await employerRequest(request, body.organizationId);
    const r = await tenant.run((tx) => (body.action === 'update' ? updateRequisition(tx, actor, id, body.input) : setRequisitionStatus(tx, actor, id, body.status)));
    return ok({ requisition: { id: r.id, status: r.status, jobId: r.jobId } });
  } catch (error) {
    return employerFail(error) ?? Promise.reject(error);
  }
});
