import { ok, route } from '@/lib/api';
import { employerDone, employerFail, employerRequest, organizationIdOf } from '@/lib/employer/request';
import { readDisclosedCandidate } from '@/lib/employer/candidate-view';

/** GET /api/employer/candidates/:userId?organizationId= - a DISCLOSED candidate's profile (granted disclosure with a current consent; audited). Anything else is 403. */
export const GET = route(async (request: Request, { params }: { params: Promise<{ userId: string }> }) => {
  const { userId } = await params;
  try {
    const { actor } = await employerRequest(request, organizationIdOf(request));
    return ok({ candidate: await employerDone(actor, () => readDisclosedCandidate(actor, userId)) });
  } catch (error) {
    return employerFail(error) ?? Promise.reject(error);
  }
});
