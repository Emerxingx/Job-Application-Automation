/**
 * Stage 17 (ADR-0032) - the request-side glue for case routes: the tenant
 * context of the ORGANISATION (membership checked by `requireTenant`, the
 * organisation id carried into the transaction for the `org` policies) plus
 * the case actor with their role. One place, so every case route is gated
 * the same way.
 */
import { requireTenant, type TenantRequest } from '@/lib/tenancy/request';
import { requestMeta } from '@/lib/security-audit';
import { fail } from '@/lib/api';
import { CaseError, requireCaseActor, type CaseActor } from './service';

export async function caseRequest(request: Request, organizationId: string | null | undefined): Promise<{ tenant: TenantRequest; actor: CaseActor }> {
  if (!organizationId) throw new CaseError('organizationId is required.', 422);
  const tenant = await requireTenant(organizationId);
  const actor = await requireCaseActor({ id: tenant.user.id, email: tenant.user.email }, organizationId, requestMeta(request));
  return { tenant, actor };
}

/** The organisation id from the query string or the body, whichever the method carries. */
export function organizationIdOf(request: Request, body?: { organizationId?: unknown }): string | null {
  const q = new URL(request.url).searchParams.get('organizationId');
  if (q) return q;
  return typeof body?.organizationId === 'string' ? body.organizationId : null;
}

export function caseFail(error: unknown): Response | null {
  if (error instanceof CaseError) return fail(error.message, error.status);
  return null;
}
