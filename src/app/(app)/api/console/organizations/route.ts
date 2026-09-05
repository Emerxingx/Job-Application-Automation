import { z } from 'zod';
import { ok } from '@/lib/api';
import { requireStaff } from '@/lib/crm/auth';
import { governanceRoute, requireStepUp } from '@/lib/crm/step-up';
import { requestMeta } from '@/lib/security-audit';
import { createVerifiedOrganization, listOrganizations } from '@/lib/admin/organizations';
import { adminFail } from '@/lib/admin/route';

/** GET /api/console/organizations?q= - every non-personal organisation with its verification, policy and SSO state. Support and above read. */
export const GET = governanceRoute(async (request: Request) => {
  await requireStaff('support');
  const q = new URL(request.url).searchParams.get('q') ?? undefined;
  return ok({ organizations: await listOrganizations({ q }) });
});

const createSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password.'),
  name: z.string().trim().min(2).max(120),
  type: z.enum(['employer', 'service_provider', 'staffing_agency']),
  ownerEmail: z.string().email(),
  billingEmail: z.string().email().optional(),
  reason: z.string().trim().min(3).max(500),
});

/** POST /api/console/organizations - create a VERIFIED organisation (the types self-service refuses) for an existing account, under step-up, audited (Stage 20, ADR-0035). Admin only. */
export const POST = governanceRoute(async (request: Request) => {
  const staff = await requireStaff('admin');
  const body = createSchema.parse(await request.json());
  await requireStepUp(staff, body.currentPassword, requestMeta(request));
  try {
    const org = await createVerifiedOrganization(staff, { name: body.name, type: body.type, ownerEmail: body.ownerEmail, billingEmail: body.billingEmail }, body.reason, requestMeta(request));
    return ok({ organization: { id: org.id, name: org.name, slug: org.slug, type: org.type, verifiedAt: org.verifiedAt } }, { status: 201 });
  } catch (error) {
    return adminFail(error) ?? Promise.reject(error);
  }
});
