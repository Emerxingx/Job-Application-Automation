import { z } from 'zod';
import { ok } from '@/lib/api';
import { requireStaff } from '@/lib/crm/auth';
import {
  approvePromptVersion,
  promotePromptVersion,
  recordPromptEvaluation,
  retirePromptVersion,
} from '@/lib/ai/prompt-registry';
import { requestMeta } from '@/lib/security-audit';
import { governanceRoute, requireStepUp } from '@/lib/crm/step-up';

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve') }),
  z.object({ action: z.literal('evaluate'), status: z.enum(['pending', 'passed', 'failed']), note: z.string().trim().max(4000).default('') }),
  z.object({ action: z.literal('promote') }),
  z.object({ action: z.literal('retire') }),
]);
const bodySchema = z.object({
  currentPassword: z.string().min(1, 'Re-enter your password to change a prompt.'),
  reason: z.string().trim().max(500).optional(),
}).and(actionSchema);

/**
 * PATCH /api/console/prompts/:id — one lifecycle transition, admin + step-up.
 * `promote` on an older version is the rollback; the registry records it as
 * such. Every transition writes an audit row (`prompt.*`).
 */
export const PATCH = governanceRoute(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const staff = await requireStaff('admin');
  const { id } = await params;
  const body = bodySchema.parse(await request.json());
  await requireStepUp(staff, body.currentPassword, requestMeta(request));
  const reason = body.reason ?? null;

  const version =
    body.action === 'approve'
      ? await approvePromptVersion(id, staff, reason)
      : body.action === 'evaluate'
        ? await recordPromptEvaluation(id, { status: body.status, note: body.note }, staff, reason)
        : body.action === 'promote'
          ? await promotePromptVersion(id, staff, reason)
          : await retirePromptVersion(id, staff, reason);
  return ok({ version });
});
