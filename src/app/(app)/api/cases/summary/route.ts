import { fail, ok, route } from '@/lib/api';
import { requireTenant } from '@/lib/tenancy/request';
import { requestMeta } from '@/lib/security-audit';
import { CaseError, caseloadSummary, requireCaseActor } from '@/lib/cases/service';

/** GET /api/cases/summary?org=&from=&to= - the supervisor's outcome summary from the cases mart (Stage 21, ADR-0036): counts, suppressed under five clients. */
export const GET = route(async (request: Request) => {
  const q = new URL(request.url).searchParams;
  const organizationId = q.get('org');
  if (!organizationId) return fail('org is required.', 422);
  const to = q.get('to') ? new Date(q.get('to')!) : new Date();
  const from = q.get('from') ? new Date(q.get('from')!) : new Date(to.getTime() - 90 * 86_400_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return fail('from and to are dates, and from is not after to.', 422);
  try {
    const tenant = await requireTenant(organizationId);
    const actor = await requireCaseActor({ id: tenant.user.id, email: tenant.user.email }, organizationId, requestMeta(request));
    return ok(await tenant.run((tx) => caseloadSummary(tx, actor, { from, to })));
  } catch (error) {
    if (error instanceof CaseError) return fail(error.message, error.status);
    throw error;
  }
});
