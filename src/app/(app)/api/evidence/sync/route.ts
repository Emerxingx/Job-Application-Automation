import { requireTenant } from '@/lib/tenancy/request';
import { ok, route } from '@/lib/api';
import { syncEvidenceFromProfile } from '@/lib/evidence/vault';

/**
 * POST /api/evidence/sync — derive evidence from the structured profile.
 * Idempotent; the report says what changed.
 */
export const POST = route(async () => {
  const { user, run } = await requireTenant();
  const report = await run((tx) => syncEvidenceFromProfile(tx, user.id));
  return ok({ report });
});
