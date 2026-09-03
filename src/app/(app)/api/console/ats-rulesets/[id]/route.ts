import { z } from 'zod';
import { ok } from '@/lib/api';
import { requireStaff } from '@/lib/crm/auth';
import { governanceRoute, requireStepUp } from '@/lib/crm/step-up';
import { activateAtsRuleset, approveAtsRuleset, retireAtsRuleset } from '@/lib/apply/ats-rulesets';
import { requestMeta } from '@/lib/security-audit';

const schema = z.object({
  currentPassword: z.string().min(1, 'Re-enter your password to change a ruleset.'),
  reason: z.string().trim().max(500).optional(),
  action: z.enum(['approve', 'activate', 'retire']),
});

/** PATCH /api/console/ats-rulesets/:id — one lifecycle transition. `activate` on an older version is the rollback. */
export const PATCH = governanceRoute(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const staff = await requireStaff('admin');
  const { id } = await params;
  const body = schema.parse(await request.json());
  await requireStepUp(staff, body.currentPassword, requestMeta(request));
  const reason = body.reason ?? null;
  const ruleset =
    body.action === 'approve' ? await approveAtsRuleset(id, staff, reason) : body.action === 'activate' ? await activateAtsRuleset(id, staff, reason) : await retireAtsRuleset(id, staff, reason);
  return ok({ ruleset });
});
