import { z } from 'zod';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { fail, ok, route } from '@/lib/api';
import { createOrganization, listMemberships, OrganizationAccessError } from '@/lib/tenancy/organizations';
import { ORGANIZATION_TYPES } from '@/lib/tenancy/roles';
import { recordSecurityEvent, requestMeta } from '@/lib/security-audit';
import { authorizeStaff } from '@/lib/crm/auth';

/** The organisations the caller belongs to, with their role in each. */
export const GET = route(async () => {
  const user = await requireUser();
  const rows = await listMemberships(db, user.id);
  return ok({
    organizations: rows.map((m) => ({
      id: m.organization.id,
      name: m.organization.name,
      slug: m.organization.slug,
      type: m.organization.type,
      aiProcessingPolicy: m.organization.aiProcessingPolicy,
      role: m.role,
      joinedAt: m.acceptedAt,
    })),
  });
});

const createSchema = z.object({
  name: z.string().min(2).max(120),
  type: z.enum(ORGANIZATION_TYPES),
  slug: z.string().min(3).max(64).optional(),
  billingEmail: z.string().email(),
});

export const POST = route(async (request: Request) => {
  const user = await requireUser();
  const body = createSchema.parse(await request.json());
  // Stage 17 review: a service-provider organisation is not self-serve; the
  // service refuses unless the caller passed the console's two-lock staff
  // gate. The refusal is audited; the message does not say whether the
  // caller is staff.
  const verifiedProvider = body.type === 'service_provider' && authorizeStaff(user).ok;
  if (body.type === 'service_provider' && !verifiedProvider) {
    await recordSecurityEvent({ event: 'organization.create.refused', user, entityType: 'Organization', entityId: '', summary: 'Self-serve creation of a service-provider organisation refused', detail: { type: body.type }, meta: requestMeta(request) });
  }
  try {
    const organization = await createOrganization(user.id, body, { verifiedProvider });
    await recordSecurityEvent({
      event: 'organization.created',
      user,
      entityType: 'Organization',
      entityId: organization.id,
      summary: `Created organization ${organization.slug} (${organization.type})`,
      detail: { type: organization.type },
      meta: requestMeta(request),
    });
    return ok({ organization }, { status: 201 });
  } catch (error) {
    if (error instanceof OrganizationAccessError) return fail(error.message, error.status);
    throw error;
  }
});
