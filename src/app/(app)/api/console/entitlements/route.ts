import { z } from 'zod';
import { db } from '@/lib/db';
import { fail, ok } from '@/lib/api';
import { requireStaff } from '@/lib/crm/auth';
import { governanceRoute, requireStepUp } from '@/lib/crm/step-up';
import { CAPABILITIES, CAPABILITY_KEYS, ENTITLEMENT_SOURCES } from '@/lib/entitlements/capabilities';
import { EntitlementError, describeEntitlements, grantEntitlement, parseCapability, revokeEntitlement } from '@/lib/entitlements/service';
import { requestMeta } from '@/lib/security-audit';

/**
 * Stage 15 - staff management of entitlements (ADR-0010): a grant WITHOUT a
 * payment (comp, pilot, licence, bonus, trial) and a revocation WITHOUT a
 * refund, each with a reason, each under step-up, each an audit row. This is
 * the only place a person changes what an account may do; every other
 * change is a plan transition.
 */

/** GET /api/console/entitlements?userId= - every row for a person and the resolved answer; the registry for the form. Billing ops and above. */
export const GET = governanceRoute(async (request: Request) => {
  await requireStaff('billing_ops');
  const userId = new URL(request.url).searchParams.get('userId');
  if (!userId) return ok({ capabilities: CAPABILITIES, sources: ENTITLEMENT_SOURCES });
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, email: true, fullName: true } });
  if (!user) return fail('No such user.', 404);
  const { rows, resolved } = await describeEntitlements(db, userId);
  return ok({ user, rows, resolved, capabilities: CAPABILITIES, sources: ENTITLEMENT_SOURCES });
});

const grantSchema = z.object({
  currentPassword: z.string().min(1, 'Re-enter your password to change entitlements.'),
  userId: z.string().min(1),
  capability: z.enum(CAPABILITY_KEYS as [string, ...string[]]),
  quantity: z.number().int().min(0).max(1_000_000).optional(),
  // `cap` LOWERS (a ceiling on a quantity, a block on a boolean); the rest grant. Plan and trial rows are the subscription module's alone.
  source: z.enum(['comp', 'pilot', 'licence', 'bonus', 'staff', 'cap']),
  sourceRef: z.string().trim().max(120).optional(),
  expiresAt: z.coerce.date().optional(),
  reason: z.string().trim().min(3, 'Say why.').max(500),
});

/** POST /api/console/entitlements - grant without a payment. Admin + step-up. */
export const POST = governanceRoute(async (request: Request) => {
  const staff = await requireStaff('admin');
  const body = grantSchema.parse(await request.json());
  await requireStepUp(staff, body.currentPassword, requestMeta(request));
  if (body.expiresAt && body.expiresAt.getTime() <= Date.now()) return fail('An expiry must be in the future.', 422);
  const user = await db.user.findUnique({ where: { id: body.userId }, select: { id: true } });
  if (!user) return fail('No such user.', 404);
  try {
    const result = await grantEntitlement(db, {
      subject: { userId: body.userId },
      capability: parseCapability(body.capability),
      quantity: body.quantity,
      source: body.source,
      sourceRef: body.sourceRef ?? `staff:${staff.id}:${Date.now()}`,
      expiresAt: body.expiresAt ?? null,
      grantedBy: `staff:${staff.id}`,
      note: body.reason,
      meta: requestMeta(request),
    });
    return ok(result, { status: 201 });
  } catch (error) {
    if (error instanceof EntitlementError) return fail(error.message, error.status);
    throw error;
  }
});

const revokeSchema = z.object({
  currentPassword: z.string().min(1, 'Re-enter your password to change entitlements.'),
  id: z.string().min(1),
  reason: z.string().trim().min(3, 'Say why.').max(500),
});

/** DELETE /api/console/entitlements - revoke one row without a refund. Admin + step-up. */
export const DELETE = governanceRoute(async (request: Request) => {
  const staff = await requireStaff('admin');
  const body = revokeSchema.parse(await request.json());
  await requireStepUp(staff, body.currentPassword, requestMeta(request));
  const revoked = await revokeEntitlement(db, body.id, { reason: 'staff', revokedBy: `staff:${staff.id}`, note: body.reason, meta: requestMeta(request) });
  if (!revoked) return fail('No such entitlement.', 404);
  return ok({ revoked: true });
});
