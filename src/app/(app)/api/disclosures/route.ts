import { ok, route } from '@/lib/api';
import { requireTenant } from '@/lib/tenancy/request';
import { listCandidateDisclosures } from '@/lib/employer/service';

/** GET /api/disclosures - the caller's own disclosure requests and grants as a CANDIDATE (their rows on their tenant path). */
export const GET = route(async () => {
  const { user, run } = await requireTenant();
  const rows = await run((tx) => listCandidateDisclosures(tx, user.id));
  return ok({ disclosures: rows.map((d) => ({ id: d.id, organization: d.organization.name, requisitionTitle: d.requisitionTitle, status: d.status, message: d.message, requestedAt: d.requestedAt, respondedAt: d.respondedAt })) });
});
