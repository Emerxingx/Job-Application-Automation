import { z } from 'zod';
import { fail, ok } from '@/lib/api';
import { requireStaff } from '@/lib/crm/auth';
import { governanceRoute, requireStepUp } from '@/lib/crm/step-up';
import { requestMeta } from '@/lib/security-audit';
import { StaffingError, ensureJurisdictionRegistry, listJurisdictionRegistry, recordJurisdictionRule } from '@/lib/staffing/service';

/** GET /api/console/staffing/jurisdictions - every targeted jurisdiction and what counsel recorded for it (L-4). Admin only; a read writes nothing. */
export const GET = governanceRoute(async () => {
  await requireStaff('admin');
  return ok({ jurisdictions: await listJurisdictionRegistry() });
});

const schema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password.'),
  jurisdiction: z.string().trim().min(2).max(6),
  status: z.enum(['recorded', 'prohibited', 'unrecorded']),
  licenceRequired: z.boolean().nullable(),
  candidateFeesProhibited: z.boolean().nullable(),
  maxGuaranteeDays: z.number().int().nullable(),
  reference: z.string().trim().max(2000),
  notes: z.string().trim().max(5000).optional(),
  reason: z.string().trim().min(3).max(500),
});

/** PATCH /api/console/staffing/jurisdictions - an admin records counsel's answer for one jurisdiction, with a citation and a reason, under step-up (L-4 is a governance decision; Stage 19 review, M10); audited. */
export const PATCH = governanceRoute(async (request: Request) => {
  const staff = await requireStaff('admin');
  const body = schema.parse(await request.json());
  await requireStepUp(staff, body.currentPassword, requestMeta(request));
  try {
    await ensureJurisdictionRegistry();
    const row = await recordJurisdictionRule(staff, body.jurisdiction, body, body.reason, requestMeta(request));
    return ok({ jurisdiction: row });
  } catch (error) {
    if (error instanceof StaffingError) return fail(error.message, error.status);
    throw error;
  }
});
