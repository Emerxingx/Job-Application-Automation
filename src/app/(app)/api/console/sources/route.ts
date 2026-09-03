import { ok } from '@/lib/api';
import { consoleRoute, requireStaff } from '@/lib/crm/auth';
import { db } from '@/lib/db';
import { ensureSourceRegistry, missingCredentials, recordComplete } from '@/lib/connectors/registry';

/** GET /api/console/sources — every registered job source with its record state, health and last runs. */
export const GET = consoleRoute(async () => {
  await requireStaff('admin');
  const sources = await ensureSourceRegistry();
  const runs = await db.jobSourceRun.findMany({ orderBy: { startedAt: 'desc' }, take: 50 });
  return ok({
    sources: sources.map((s) => ({ ...s, recordComplete: recordComplete(s), missingCredentials: missingCredentials(s) })),
    runs,
  });
});
