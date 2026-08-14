import { z } from 'zod';
import { fail, ok } from '@/lib/api';
import { consoleRoute, requireStaff } from '@/lib/crm/auth';
import { getCustomerDetail, refreshCustomerMetrics, updateCustomerCrm } from '@/lib/crm/customers';
import { LIFECYCLE_RULE_BOOK, LIFECYCLE_STAGES, RISK_LEVELS } from '@/lib/crm/lifecycle';

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/console/customers/:id — the 360° view.
 *
 * `:id` is the User id. Customer (CRM) rows are created lazily, so the user is
 * the only key that exists for every account.
 *
 * The read refreshes that customer's cached metrics first. It is a GET that
 * writes, which is worth being explicit about: the write is an idempotent
 * recomputation of derived columns, and doing it here means the list, the
 * reports and the badge on screen agree for every account a human has looked
 * at. It never touches product state — the quota window in particular is read
 * without being rolled forward.
 */
export const GET = consoleRoute(async (_request: Request, { params }: Params) => {
  await requireStaff('support');
  const { id } = await params;

  await refreshCustomerMetrics(id);
  const detail = await getCustomerDetail(id);
  if (!detail) return fail('Customer not found.', 404);

  // Shipped with the record so the console can explain the risk badge without
  // hardcoding a second copy of the rules.
  return ok({ customer: detail, ruleBook: LIFECYCLE_RULE_BOOK });
});

const patchSchema = z
  .object({
    lifecycleStage: z.enum(LIFECYCLE_STAGES).optional(),
    ownerStaffId: z.string().max(40).nullable().optional(),
    segment: z.enum(['self_serve', 'smb', 'enterprise']).optional(),
    source: z.enum(['organic', 'referral', 'paid_search', 'partner', 'outbound']).optional(),
    campaign: z.string().max(120).nullable().optional(),
    riskLevel: z.enum(RISK_LEVELS).optional(),
    vip: z.boolean().optional(),
    doNotContact: z.boolean().optional(),
    churnReason: z
      .enum(['price', 'missing_feature', 'found_job', 'support', 'involuntary', 'unknown'])
      .nullable()
      .optional(),
    internalNotes: z.string().max(4000).optional(),
    reason: z.string().max(500).optional(),
  })
  .refine((body) => Object.keys(body).some((key) => key !== 'reason'), {
    message: 'Nothing to update.',
  });

/**
 * PATCH /api/console/customers/:id — staff edits to the CRM record.
 *
 * Requires billing_ops or admin, not plain support: lifecycleStage and
 * churnReason feed the revenue reporting finance signs off on, and
 * doNotContact is a CASL consent flag. Those are not fields to hand to every
 * console login.
 *
 * lifecycleStage and riskLevel are DERIVED values. Setting them by hand is a
 * correction that holds until the next metrics refresh recomputes them from
 * subscription signals; judgement that must persist belongs in segment,
 * churnReason or internalNotes.
 */
export const PATCH = consoleRoute(async (request: Request, { params }: Params) => {
  const staff = await requireStaff('billing_ops');
  const { id } = await params;
  const { reason, ...patch } = patchSchema.parse(await request.json());

  const result = await updateCustomerCrm(id, patch, staff, reason);
  if (!result) return fail('Customer not found.', 404);

  const detail = await getCustomerDetail(id);
  return ok({ changed: result.changed, customer: detail });
});
