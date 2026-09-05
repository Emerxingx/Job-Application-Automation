import { db } from '../db';
import { requireUser, type CurrentUser } from '../auth';
import { withTenant, type TenantTx, type WithTenantOptions } from './context';
import { OrganizationAccessError, personalOrganizationId, requireMembership } from './organizations';

/**
 * The request-level entry point to the tenant path.
 *
 *   const { user, run } = await requireTenant();
 *   const rows = await run((tx) => tx.application.findMany({ where: { userId: user.id } }));
 *
 * `run` executes its callback inside a transaction that carries the user's
 * tenant context, so the RLS backstop applies to every query in it. The
 * application filter (`where: { userId }`) STAYS — ADR-0005 point 5: RLS
 * catches the forgotten clause, it does not excuse one.
 *
 * The organisation context defaults to the user's personal workspace. Routes
 * that act within another organisation pass its id explicitly; the caller's
 * ACTIVE membership of it is checked here (fail closed, 404 for a stranger)
 * before any context is established, and the policies then decide what that
 * membership grants. Passing an organisation id never widens access on its
 * own: no policy reads `app.current_organization_id` yet — it is carried so
 * organisation-scoped policies can be added without changing every caller.
 */
export interface TenantRequest {
  user: CurrentUser;
  organizationId: string;
  run: <T>(fn: (tx: TenantTx) => Promise<T>, options?: WithTenantOptions) => Promise<T>;
}

export async function requireTenant(organizationId?: string): Promise<TenantRequest> {
  const user = await requireUser();
  const orgId = organizationId ?? personalOrganizationId(user.id);
  if (organizationId !== undefined) {
    await requireMembership(db, orgId, user.id, 'member');
    // Stage 20 (ADR-0035): a suspended organisation has no tenant path. Its
    // rows stay; its members cannot act in it until staff reactivate it.
    const org = await db.organization.findUnique({ where: { id: orgId }, select: { status: true } });
    if (org?.status === 'suspended') throw new OrganizationAccessError('This organisation is suspended. Contact support.', 403);
  }
  return {
    user,
    organizationId: orgId,
    run: (fn, options) => withTenant({ userId: user.id, organizationId: orgId }, fn, options),
  };
}
