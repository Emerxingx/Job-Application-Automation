import { z } from 'zod';
import { ok } from '@/lib/api';
import { requireStaff } from '@/lib/crm/auth';
import { governanceRoute } from '@/lib/crm/step-up';
import { runRefresh } from '@/lib/connectors/pipeline';

const schema = z.object({ staleAfterHours: z.number().int().min(1).max(24 * 30).optional(), limit: z.number().int().min(1).max(1000).optional() });

/**
 * POST /api/console/sources/:key/refresh — run one freshness sweep now
 * (admin). Goes through the same gate as discovery: a disabled, incomplete
 * or uncredentialed source is refused and the refusal recorded. Stage 06:
 * until a scheduler exists (Stage 24), sweeps are started here or by
 * `npm run jobs:freshness`.
 */
export const POST = governanceRoute(async (request: Request, { params }: { params: Promise<{ key: string }> }) => {
  await requireStaff('admin');
  const { key } = await params;
  const body = schema.parse(await request.json().catch(() => ({})));
  const run = await runRefresh(key, { staleAfterMs: body.staleAfterHours ? body.staleAfterHours * 3_600_000 : undefined, limit: body.limit });
  return ok({ run });
});
