import { z } from 'zod';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { fail, ok, route } from '@/lib/api';
import { createOrganization, listMemberships, OrganizationAccessError } from '@/lib/tenancy/organizations';
import { ORGANIZATION_TYPES } from '@/lib/tenancy/roles';
import { recordSecurityEvent, requestMeta } from '@/lib/security-audit';

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
  try {
    const organization = await createOrganization(user.id, body);
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
