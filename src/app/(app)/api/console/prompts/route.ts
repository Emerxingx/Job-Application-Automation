import { z } from 'zod';
import { ok } from '@/lib/api';
import { consoleRoute, requireStaff } from '@/lib/crm/auth';
import { createPromptVersion, listPromptVersions } from '@/lib/ai/prompt-registry';
import { requestMeta } from '@/lib/security-audit';
import { promptGovernanceRoute, requireStepUp } from './step-up';

/**
 * GET /api/console/prompts — every version of every prompt. Reading is a
 * support-level action: the text is INTERNAL configuration, not personal data.
 */
export const GET = consoleRoute(async () => {
  await requireStaff('support');
  const versions = await listPromptVersions();
  return ok({ versions });
});

const createSchema = z.object({
  currentPassword: z.string().min(1, 'Re-enter your password to change a prompt.'),
  reason: z.string().trim().max(500).optional(),
  slug: z.string().trim().min(2).max(64),
  targetModel: z.string().trim().min(1).max(100),
  modelProvider: z.enum(['anthropic']).optional(),
  systemPrompt: z.string().min(1).max(20000),
  userPromptTemplate: z.string().max(20000).nullable().optional(),
  requiredVariables: z.array(z.string().trim().max(64)).max(30).default([]),
  modelParameters: z.record(z.string(), z.unknown()).optional(),
  outputSchema: z.record(z.string(), z.unknown()).nullable().optional(),
  notes: z.string().max(2000).optional(),
});

/**
 * POST /api/console/prompts — a new DRAFT version. Admin only, with step-up:
 * the caller re-enters their password, so a hijacked staff session cannot
 * rewrite a system prompt on its own (ADR-0019 Tier 1, AI_GOVERNANCE.md).
 */
export const POST = promptGovernanceRoute(async (request: Request) => {
  const staff = await requireStaff('admin');
  const body = createSchema.parse(await request.json());
  await requireStepUp(staff, body.currentPassword, requestMeta(request));
  const { currentPassword: _pw, reason, ...input } = body;
  void _pw;
  const version = await createPromptVersion(input, staff, reason ?? null);
  return ok({ version }, { status: 201 });
});
