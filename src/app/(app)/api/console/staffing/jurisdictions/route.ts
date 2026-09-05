import { z } from 'zod';
import { ok } from '@/lib/api';
import { consoleRoute, requireStaff } from '@/lib/crm/auth';
import { requestMeta } from '@/lib/security-audit';
import { fail } from '@/lib/api';
import { StaffingError, ensureJurisdictionRegistry, recordJurisdictionRule } from '@/lib/staffing/service';

/** GET /api/console/staffing/jurisdictions - every targeted jurisdiction and what counsel recorded for it (L-4). Admin only. */
export const GET = consoleRoute(async () => {
  await requireStaff('admin');
  return ok({ jurisdictions: await ensureJurisdictionRegistry() });
});

const schema = z.object({
  jurisdiction: z.string().trim().min(2).max(6),
  status: z.enum(['recorded', 'prohibited', 'unrecorded']),
  licenceRequired: z.boolean().nullable(),
  candidateFeesProhibited: z.boolean().nullable(),
  maxGuaranteeDays: z.number().int().nullable(),
  reference: z.string().trim().max(2000),
  notes: z.string().trim().max(5000).optional(),
  reason: z.string().trim().min(3).max(500),
});

/** PATCH /api/console/staffing/jurisdictions - an admin records counsel's answer for one jurisdiction, with a citation and a reason; audited. */
export const PATCH = consoleRoute(async (request: Request) => {
  const staff = await requireStaff('admin');
  const body = schema.parse(await request.json());
  try {
    const row = await recordJurisdictionRule(staff, body.jurisdiction, body, body.reason, requestMeta(request));
    return ok({ jurisdiction: row });
  } catch (error) {
    if (error instanceof StaffingError) return fail(error.message, error.status);
    throw error;
  }
});
