import { z } from 'zod';
import { ok } from '@/lib/api';
import { requireStaff } from '@/lib/crm/auth';
import { governanceRoute, requireStepUp } from '@/lib/crm/step-up';
import { ATS_PLATFORMS, NAVIGATION_FLOWS, PACING, createAtsRuleset, listAtsRulesets } from '@/lib/apply/ats-rulesets';
import { requestMeta } from '@/lib/security-audit';

/** GET /api/console/ats-rulesets — every version of every platform's ruleset. Admin only. */
export const GET = governanceRoute(async () => {
  await requireStaff('admin');
  return ok({ rulesets: await listAtsRulesets() });
});

const createSchema = z.object({
  currentPassword: z.string().min(1, 'Re-enter your password to change a ruleset.'),
  reason: z.string().trim().max(500).optional(),
  platform: z.enum(ATS_PLATFORMS),
  navigationFlowType: z.enum(NAVIGATION_FLOWS).default('single_page'),
  pacing: z.enum(PACING).default('standard'),
  selectorMap: z.record(z.string(), z.string().max(1000)),
  fallbackSelectors: z.record(z.string(), z.array(z.string().max(1000)).max(20)).nullable().optional(),
  notes: z.string().max(4000).optional(),
});

/** POST /api/console/ats-rulesets — a new DRAFT version. Admin + step-up. */
export const POST = governanceRoute(async (request: Request) => {
  const staff = await requireStaff('admin');
  const body = createSchema.parse(await request.json());
  await requireStepUp(staff, body.currentPassword, requestMeta(request));
  const { currentPassword: _pw, reason, ...input } = body;
  void _pw;
  const ruleset = await createAtsRuleset(input, staff, reason ?? null);
  return ok({ ruleset }, { status: 201 });
});
