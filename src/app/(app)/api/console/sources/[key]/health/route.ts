import { ok } from '@/lib/api';
import { requireStaff } from '@/lib/crm/auth';
import { governanceRoute } from '@/lib/crm/step-up';
import { runHealthCheck } from '@/lib/connectors/pipeline';

/** POST /api/console/sources/:key/health — run the connector's health check now (admin; read-only against the source). */
export const POST = governanceRoute(async (_request: Request, { params }: { params: Promise<{ key: string }> }) => {
  await requireStaff('admin');
  const { key } = await params;
  const result = await runHealthCheck(key);
  return ok(result);
});
