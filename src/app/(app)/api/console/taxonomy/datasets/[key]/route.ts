import { z } from 'zod';
import { ok } from '@/lib/api';
import { requireStaff } from '@/lib/crm/auth';
import { governanceRoute, requireStepUp } from '@/lib/crm/step-up';
import { recordDatasetLicence } from '@/lib/taxonomy/datasets';
import { requestMeta } from '@/lib/security-audit';

const schema = z.object({
  currentPassword: z.string().min(1, 'Re-enter your password to record a licence decision.'),
  status: z.enum(['recorded', 'prohibited']),
  licenceName: z.string().trim().max(200).default(''),
  licenceUrl: z.string().trim().max(500).optional(),
  attribution: z.string().trim().max(1000).default(''),
  ingestionApproved: z.boolean().default(false),
  notes: z.string().max(4000).optional(),
  reason: z.string().trim().min(1, 'Name the review or the counsel advice this records.').max(500),
});

/**
 * PATCH /api/console/taxonomy/datasets/:key — record a dataset's licence
 * (or counsel's prohibition) and whether ingestion is approved. Admin-only,
 * step-up re-authenticated (this is the L-2 gate being opened or closed, by
 * a person) and audited. Withdrawing approval or prohibiting a dataset that
 * has been loaded PURGES its rows: a prohibition cannot leave data serving.
 */
export const PATCH = governanceRoute(async (request: Request, { params }: { params: Promise<{ key: string }> }) => {
  const staff = await requireStaff('admin');
  const { key } = await params;
  const body = schema.parse(await request.json());
  await requireStepUp(staff, body.currentPassword, requestMeta(request));
  const { currentPassword: _pw, reason, ...record } = body;
  void _pw;
  const result = await recordDatasetLicence(key, record, staff, reason);
  return ok(result);
});
