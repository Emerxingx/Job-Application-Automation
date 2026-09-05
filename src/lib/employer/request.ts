/**
 * Stage 18 (ADR-0033) - the request-side glue for employer routes: the
 * tenant context of the ORGANISATION plus the employer actor with their
 * role. One place, so every employer route is gated the same way; a
 * refusal from the connector gate (the first-party source disabled by
 * staff) is answered with its own message and status.
 */
import { requireTenant, type TenantRequest } from '@/lib/tenancy/request';
import { requestMeta } from '@/lib/security-audit';
import { fail } from '@/lib/api';
import { SourceAccessError } from '@/lib/connectors/registry';
import { ConsentWordingPendingError } from '@/lib/consent';
import { EmployerError, bufferedActor, flushEmployerAudit, requireEmployerActor, type EmployerActor } from './service';

export async function employerRequest(request: Request, organizationId: string | null | undefined): Promise<{ tenant: TenantRequest; actor: EmployerActor }> {
  if (!organizationId) throw new EmployerError('organizationId is required.', 422);
  const tenant = await requireTenant(organizationId);
  // The actor buffers its audit rows; `employerDone` writes them once the work
  // (and its transaction) has finished, so a rolled-back move leaves no row.
  const actor = bufferedActor(await requireEmployerActor({ id: tenant.user.id, email: tenant.user.email }, organizationId, requestMeta(request)));
  return { tenant, actor };
}

/** Run an employer operation and flush its buffered audit rows after it completes. */
export async function employerDone<T>(actor: EmployerActor, work: () => Promise<T>): Promise<T> {
  const result = await work();
  await flushEmployerAudit(actor);
  return result;
}

/** The organisation id from the query string or the body, whichever the method carries. */
export function organizationIdOf(request: Request, body?: { organizationId?: unknown }): string | null {
  const q = new URL(request.url).searchParams.get('organizationId');
  if (q) return q;
  return typeof body?.organizationId === 'string' ? body.organizationId : null;
}

export function employerFail(error: unknown): Response | null {
  if (error instanceof EmployerError) return fail(error.message, error.status);
  if (error instanceof SourceAccessError) return fail(error.message, error.status);
  if (error instanceof ConsentWordingPendingError) return fail(error.message, error.status);
  return null;
}
