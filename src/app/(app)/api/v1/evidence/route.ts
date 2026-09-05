import { listEvidence, PUBLIC_EVIDENCE_STATUSES } from '@/lib/integrations/candidate-api';
import { listEnvelope, parseEnumParam, parsePagination, v1Ok, v1Route } from '@/lib/integrations/http';

/** GET /api/v1/evidence (v1.1) - the vault's claims, read-only; `status` filters, default draft + approved (contract: EvidenceList). */
export const GET = v1Route('read', async (context) => {
  const pagination = parsePagination(context.url);
  const status = parseEnumParam(context.url, 'status', PUBLIC_EVIDENCE_STATUSES);
  const { data, total } = await listEvidence(context.key.userId, pagination, status);
  return v1Ok(context, listEnvelope(data, pagination, total));
});
