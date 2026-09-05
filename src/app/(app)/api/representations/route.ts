import { ok, route } from '@/lib/api';
import { requireTenant } from '@/lib/tenancy/request';
import { listCandidateRepresentations } from '@/lib/staffing/service';

/** GET /api/representations - the caller's own representation requests and grants as a CANDIDATE. */
export const GET = route(async () => {
  const { user, run } = await requireTenant();
  const rows = await run((tx) => listCandidateRepresentations(tx, { id: user.id, email: user.email }));
  return ok({ representations: rows.map((r) => ({ id: r.id, agency: r.organization.name, engagement: r.engagement, status: r.status, message: r.message, requestedAt: r.requestedAt, respondedAt: r.respondedAt })) });
});
