import { ok, route } from '@/lib/api';
import { caseFail, caseRequest, organizationIdOf } from '@/lib/cases/request';
import { readClientSummary } from '@/lib/cases/client-view';

/** GET /api/cases/:caseId/client?organizationId= - the consented client's job-search summary (a delegated, audited read). */
export const GET = route(async (request: Request, { params }: { params: Promise<{ caseId: string }> }) => {
  const { caseId } = await params;
  try {
    const { actor } = await caseRequest(request, organizationIdOf(request));
    const summary = await readClientSummary(actor, caseId);
    return ok({ summary });
  } catch (error) {
    return caseFail(error) ?? Promise.reject(error);
  }
});
