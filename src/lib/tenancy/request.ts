import { requireUser, type CurrentUser } from '../auth';
import { withTenant, type TenantTx, type WithTenantOptions } from './context';
import { personalOrganizationId } from './organizations';

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
 * that act within another organisation pass its id explicitly, and it is
 * still only the membership-derived policies that decide what that grants.
 */
export interface TenantRequest {
  user: CurrentUser;
  organizationId: string;
  run: <T>(fn: (tx: TenantTx) => Promise<T>, options?: WithTenantOptions) => Promise<T>;
}

export async function requireTenant(organizationId?: string): Promise<TenantRequest> {
  const user = await requireUser();
  const orgId = organizationId ?? personalOrganizationId(user.id);
  return {
    user,
    organizationId: orgId,
    run: (fn, options) => withTenant({ userId: user.id, organizationId: orgId }, fn, options),
  };
}
