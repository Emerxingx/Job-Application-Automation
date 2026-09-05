import { fail, ok, route } from '@/lib/api';
import { employerDone, employerFail, employerRequest, organizationIdOf } from '@/lib/employer/request';
import { reporting } from '@/lib/employer/service';

/** GET /api/employer/reporting?organizationId=&from=&to= - funnel, time-to-stage medians, source performance and recruiter activity from the organisation's own pipeline events (no candidate identity). */
export const GET = route(async (request: Request) => {
  try {
    const { tenant, actor } = await employerRequest(request, organizationIdOf(request));
    const q = new URL(request.url).searchParams;
    const to = q.get('to') ? new Date(q.get('to')!) : new Date();
    const from = q.get('from') ? new Date(q.get('from')!) : new Date(to.getTime() - 90 * 86_400_000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return fail('from and to are ISO dates with from before to.', 422);
    return ok(await employerDone(actor, () => tenant.run((tx) => reporting(tx, actor, { from, to }))));
  } catch (error) {
    return employerFail(error) ?? Promise.reject(error);
  }
});
