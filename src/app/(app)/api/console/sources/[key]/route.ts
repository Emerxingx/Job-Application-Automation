import { z } from 'zod';
import { ok } from '@/lib/api';
import { requireStaff } from '@/lib/crm/auth';
import { governanceRoute, requireStepUp } from '@/lib/crm/step-up';
import { recordSourcePolicy } from '@/lib/connectors/registry';
import { requestMeta } from '@/lib/security-audit';

const schema = z.object({
  currentPassword: z.string().min(1, 'Re-enter your password to change a job source.'),
  action: z.enum(['enable', 'disable', 'record']),
  legalBasis: z.string().trim().max(2000).default(''),
  robotsPosition: z.string().trim().max(500).optional(),
  rateLimitPerMinute: z.number().int().min(0).max(100000).optional(),
  attributionRequired: z.boolean().optional(),
  attributionText: z.string().trim().max(500).optional(),
  dataCategories: z.array(z.string().trim().max(100)).max(20).optional(),
  personalData: z.boolean().optional(),
  retentionRef: z.string().trim().max(200).default(''),
  notes: z.string().max(4000).optional(),
  reason: z.string().trim().min(1, 'Name the terms review this records.').max(500),
});

/**
 * PATCH /api/console/sources/:key — record the per-connector policy and
 * enable or disable the source. Admin + step-up + audit: enabling a source
 * is the SOURCE_ACCESS_POLICY.md approval, by a person.
 */
export const PATCH = governanceRoute(async (request: Request, { params }: { params: Promise<{ key: string }> }) => {
  const staff = await requireStaff('admin');
  const { key } = await params;
  const body = schema.parse(await request.json());
  await requireStepUp(staff, body.currentPassword, requestMeta(request));
  const { currentPassword: _pw, reason, ...record } = body;
  void _pw;
  const source = await recordSourcePolicy(key, record, staff, reason);
  return ok({ source });
});
