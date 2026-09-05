import { ok, route } from '@/lib/api';
import { employerFail, employerRequest, organizationIdOf } from '@/lib/employer/request';
import { sourceCandidates } from '@/lib/employer/candidate-view';

/** GET /api/employer/requisitions/:id/sourcing?organizationId=&limit= - anonymised, scored candidate cards for an OPEN requisition (audited; a hidden candidate never appears). */
export const GET = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  try {
    const { actor } = await employerRequest(request, organizationIdOf(request));
    const limit = Number(new URL(request.url).searchParams.get('limit') ?? '25');
    return ok(await sourceCandidates(actor, id, { limit: Number.isFinite(limit) ? limit : 25 }));
  } catch (error) {
    return employerFail(error) ?? Promise.reject(error);
  }
});
