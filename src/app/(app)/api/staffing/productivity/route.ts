import { fail, ok, route } from '@/lib/api';
import { organizationIdOf, staffingFail, staffingRequest } from '@/lib/staffing/request';
import { recruiterProductivity } from '@/lib/staffing/service';

/** GET /api/staffing/productivity?organizationId=&from=&to= - per-recruiter counts (fees for admin, recruiter-own and finance only). */
export const GET = route(async (request: Request) => {
  try {
    const { tenant, actor } = await staffingRequest(request, organizationIdOf(request));
    const q = new URL(request.url).searchParams;
    const to = q.get('to') ? new Date(q.get('to')!) : new Date();
    const from = q.get('from') ? new Date(q.get('from')!) : new Date(to.getTime() - 90 * 86_400_000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return fail('from and to are dates, and from is not after to.', 422);
    return ok(await tenant.run((tx) => recruiterProductivity(tx, actor, { from, to })));
  } catch (error) {
    return staffingFail(error) ?? Promise.reject(error);
  }
});
