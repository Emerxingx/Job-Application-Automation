import { z } from 'zod';
import { requireTenant } from '@/lib/tenancy/request';
import { fail, ok, route } from '@/lib/api';
import { EvidenceError, approveEvidence, reviseEvidence, revokeEvidence } from '@/lib/evidence/vault';

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve') }),
  z.object({ action: z.literal('revoke') }),
  z.object({
    action: z.literal('revise'),
    claim: z.string().trim().min(3).max(500),
    facts: z.record(z.string(), z.union([z.string().max(500), z.number(), z.null()])).optional(),
  }),
]);

/**
 * PATCH /api/evidence/:id — approve, revoke, or revise (which creates a new
 * draft version when the item is approved; approved rows are never edited).
 */
export const PATCH = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { user, run } = await requireTenant();
  const { id } = await params;
  const body = actionSchema.parse(await request.json());
  try {
    const evidence = await run((tx) => {
      if (body.action === 'approve') return approveEvidence(tx, user.id, id);
      if (body.action === 'revoke') return revokeEvidence(tx, user.id, id);
      return reviseEvidence(tx, user.id, id, { claim: body.claim, facts: body.facts });
    });
    return ok({ evidence });
  } catch (error) {
    if (error instanceof EvidenceError) return fail(error.message, error.status);
    throw error;
  }
});
