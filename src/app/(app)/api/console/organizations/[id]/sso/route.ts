import { z } from 'zod';
import { ok } from '@/lib/api';
import { requireStaff } from '@/lib/crm/auth';
import { governanceRoute, requireStepUp } from '@/lib/crm/step-up';
import { requestMeta } from '@/lib/security-audit';
import { upsertSsoConnection } from '@/lib/sso/service';
import { adminFail } from '@/lib/admin/route';

const schema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password.'),
  issuer: z.string().trim().url().max(500),
  clientId: z.string().trim().min(1).max(500),
  clientSecret: z.string().max(2000).optional(),
  emailDomain: z.string().trim().toLowerCase().min(3).max(253),
  jitProvisioning: z.boolean(),
  status: z.enum(['enabled', 'disabled']),
  reason: z.string().trim().min(3).max(500),
});

/** PUT /api/console/organizations/:id/sso - create or update the organisation's OIDC connection. The secret is encrypted at rest and never returned. Admin, step-up, audited (Stage 20, ADR-0035). */
export const PUT = governanceRoute(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const staff = await requireStaff('admin');
  const { id } = await params;
  const body = schema.parse(await request.json());
  await requireStepUp(staff, body.currentPassword, requestMeta(request));
  try {
    const connection = await upsertSsoConnection(staff, id, { issuer: body.issuer, clientId: body.clientId, clientSecret: body.clientSecret ?? null, emailDomain: body.emailDomain, jitProvisioning: body.jitProvisioning, status: body.status }, body.reason, requestMeta(request));
    return ok({ connection });
  } catch (error) {
    return adminFail(error) ?? Promise.reject(error);
  }
});
