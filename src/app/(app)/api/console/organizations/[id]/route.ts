import { z } from 'zod';
import { fail, ok } from '@/lib/api';
import { requireStaff } from '@/lib/crm/auth';
import { governanceRoute, requireStepUp } from '@/lib/crm/step-up';
import { requestMeta } from '@/lib/security-audit';
import { organizationDetail, setOrganizationStatus, setTenantPolicy } from '@/lib/admin/organizations';
import { adminFail } from '@/lib/admin/route';

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/console/organizations/:id - the organisation, its members, policy, SSO connection (never the secret) and SCIM tokens (never a token). */
export const GET = governanceRoute(async (_request: Request, { params }: Ctx) => {
  await requireStaff('support');
  const { id } = await params;
  const detail = await organizationDetail(id);
  if (!detail) return fail('Organisation not found.', 404);
  return ok({ organization: detail });
});

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status'), currentPassword: z.string().min(1), status: z.enum(['active', 'suspended']), reason: z.string().trim().min(3).max(500) }),
  z.object({ action: z.literal('policy'), currentPassword: z.string().min(1), requireSso: z.boolean(), allowedEmailDomains: z.array(z.string().trim().toLowerCase().max(253)).max(50), sessionMaxHours: z.number().int().min(1).max(720).nullable(), reason: z.string().trim().min(3).max(500) }),
]);

/** PATCH /api/console/organizations/:id - suspend/reactivate, or set the tenant policy (require SSO, allowed domains, session ceiling). Admin, step-up, audited. */
export const PATCH = governanceRoute(async (request: Request, { params }: Ctx) => {
  const staff = await requireStaff('admin');
  const { id } = await params;
  const body = schema.parse(await request.json());
  await requireStepUp(staff, body.currentPassword, requestMeta(request));
  try {
    if (body.action === 'status') {
      const org = await setOrganizationStatus(staff, id, body.status, body.reason, requestMeta(request));
      return ok({ organization: { id: org.id, status: org.status } });
    }
    const org = await setTenantPolicy(staff, id, { requireSso: body.requireSso, allowedEmailDomains: body.allowedEmailDomains, sessionMaxHours: body.sessionMaxHours }, body.reason, requestMeta(request));
    return ok({ organization: { id: org.id, requireSso: org.requireSso, allowedEmailDomains: JSON.parse(org.allowedEmailDomains), sessionMaxHours: org.sessionMaxHours } });
  } catch (error) {
    return adminFail(error) ?? Promise.reject(error);
  }
});
