import { ok } from '@/lib/api';
import { consoleRoute, requireStaff } from '@/lib/crm/auth';
import { ensureDatasetRegistry } from '@/lib/taxonomy/datasets';
import { db } from '@/lib/db';
import { completeness } from '@/lib/taxonomy/queries';

/** GET /api/console/taxonomy/datasets — every registered dataset with its licence state, plus the integrity report. */
export const GET = consoleRoute(async () => {
  await requireStaff('admin');
  const datasets = await ensureDatasetRegistry();
  const report = await completeness(db);
  return ok({ datasets, report });
});
