import { requireUser } from '@/lib/auth';
import { fail, ok, route } from '@/lib/api';
import { acceptInvitation, OrganizationAccessError } from '@/lib/tenancy/organizations';
import { recordSecurityEvent, requestMeta } from '@/lib/security-audit';

/** Accept one's own pending invitation. */
export const POST = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await params;
  try {
    const membership = await acceptInvitation(user.id, id);
    await recordSecurityEvent({
      event: 'organization.member.accepted',
      user,
      entityType: 'Membership',
      entityId: membership.id,
      summary: 'Accepted an organization invitation',
      detail: { organizationId: id, role: membership.role },
      meta: requestMeta(request),
    });
    return ok({ ok: true, role: membership.role });
  } catch (error) {
    if (error instanceof OrganizationAccessError) return fail(error.message, error.status);
    throw error;
  }
});
