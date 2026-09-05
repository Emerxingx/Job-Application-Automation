import { z } from 'zod';
import { ok } from '@/lib/api';
import { requireStaff } from '@/lib/crm/auth';
import { governanceRoute, requireStepUp } from '@/lib/crm/step-up';
import { requestMeta } from '@/lib/security-audit';
import { issueScimToken, revokeScimToken } from '@/lib/scim/service';
import { adminFail } from '@/lib/admin/route';

const issueSchema = z.object({ currentPassword: z.string().min(1), reason: z.string().trim().min(3).max(500) });
const revokeSchema = z.object({ currentPassword: z.string().min(1), tokenId: z.string().min(1), reason: z.string().trim().min(3).max(500) });

/** POST /api/console/organizations/:id/scim-tokens - issue a provisioning token; the plaintext is in THIS response only. Admin, step-up, audited. */
export const POST = governanceRoute(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const staff = await requireStaff('admin');
  const { id } = await params;
  const body = issueSchema.parse(await request.json());
  await requireStepUp(staff, body.currentPassword, requestMeta(request));
  try {
    const issued = await issueScimToken(staff, id, body.reason, requestMeta(request));
    return ok({ token: issued }, { status: 201 });
  } catch (error) {
    return adminFail(error) ?? Promise.reject(error);
  }
});

/** DELETE /api/console/organizations/:id/scim-tokens - revoke one. */
export const DELETE = governanceRoute(async (request: Request) => {
  const staff = await requireStaff('admin');
  const body = revokeSchema.parse(await request.json());
  await requireStepUp(staff, body.currentPassword, requestMeta(request));
  try {
    await revokeScimToken(staff, body.tokenId, body.reason, requestMeta(request));
    return ok({ revoked: true });
  } catch (error) {
    return adminFail(error) ?? Promise.reject(error);
  }
});
