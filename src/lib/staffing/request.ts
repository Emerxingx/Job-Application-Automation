/** Stage 19 (ADR-0034) - the request-side glue for staffing routes: the organisation's tenant context plus the staffing actor with their role. */
import { requireTenant, type TenantRequest } from '@/lib/tenancy/request';
import { requestMeta } from '@/lib/security-audit';
import { fail } from '@/lib/api';
import { ConsentWordingPendingError } from '@/lib/consent';
import { StaffingError, requireStaffingActor, type StaffingActor } from './service';

export async function staffingRequest(request: Request, organizationId: string | null | undefined): Promise<{ tenant: TenantRequest; actor: StaffingActor }> {
  if (!organizationId) throw new StaffingError('organizationId is required.', 422);
  const tenant = await requireTenant(organizationId);
  const actor = await requireStaffingActor({ id: tenant.user.id, email: tenant.user.email }, organizationId, requestMeta(request));
  return { tenant, actor };
}

export function organizationIdOf(request: Request, body?: { organizationId?: unknown }): string | null {
  const q = new URL(request.url).searchParams.get('organizationId');
  if (q) return q;
  return typeof body?.organizationId === 'string' ? body.organizationId : null;
}

export function staffingFail(error: unknown): Response | null {
  if (error instanceof StaffingError) return fail(error.message, error.status);
  if (error instanceof ConsentWordingPendingError) return fail(error.message, error.status);
  return null;
}
