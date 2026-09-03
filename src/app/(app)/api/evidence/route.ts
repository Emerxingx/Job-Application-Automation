import { z } from 'zod';
import { requireTenant } from '@/lib/tenancy/request';
import { fail, ok, route } from '@/lib/api';
import { EVIDENCE_KINDS, EVIDENCE_STATUSES, EvidenceError, addManualEvidence, listEvidence, type EvidenceStatus } from '@/lib/evidence/vault';

/** GET /api/evidence — the candidate's vault, optionally filtered by status. */
export const GET = route(async (request: Request) => {
  const { user, run } = await requireTenant();
  const status = new URL(request.url).searchParams.get('status');
  const filter = status && (EVIDENCE_STATUSES as readonly string[]).includes(status) ? (status as EvidenceStatus) : undefined;
  const evidence = await run((tx) => listEvidence(tx, user.id, filter));
  return ok({ evidence });
});

const createSchema = z.object({
  kind: z.enum(EVIDENCE_KINDS),
  claim: z.string().trim().min(3, 'Write the claim as one sentence.').max(500),
  facts: z.record(z.string(), z.union([z.string().max(500), z.number(), z.null()])).optional(),
});

/** POST /api/evidence — a claim typed in directly. Starts as a draft. */
export const POST = route(async (request: Request) => {
  const { user, run } = await requireTenant();
  const body = createSchema.parse(await request.json());
  try {
    const created = await run((tx) => addManualEvidence(tx, user.id, body));
    return ok({ evidence: created }, { status: 201 });
  } catch (error) {
    if (error instanceof EvidenceError) return fail(error.message, error.status);
    throw error;
  }
});
