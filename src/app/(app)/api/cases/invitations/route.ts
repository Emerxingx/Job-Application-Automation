import { ok, route } from '@/lib/api';
import { requireTenant } from '@/lib/tenancy/request';
import { listClientCases } from '@/lib/cases/service';

/** GET /api/cases/invitations - the caller's own invitations and cases as a CLIENT (linked cases on their tenant path; invitations addressed to their account's email). */
export const GET = route(async () => {
  const { user, run } = await requireTenant();
  const rows = await run((tx) => listClientCases(tx, { id: user.id, email: user.email }));
  return ok({ cases: rows.map((c) => ({ id: c.id, organization: c.organization.name, status: c.status, consentedAt: c.consentedAt, createdAt: c.createdAt })) });
});
