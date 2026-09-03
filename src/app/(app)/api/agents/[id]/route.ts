import { z } from 'zod';
import { requireTenant } from '@/lib/tenancy/request';
import { fail, ok, route } from '@/lib/api';

const patchSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  status: z.enum(['active', 'paused']).optional(),
  minMatchScore: z.number().int().min(0).max(100).optional(),
  autoApply: z.boolean().optional(),
  autoApplyThreshold: z.number().int().min(0).max(100).optional(),
  scanFrequency: z.enum(['hourly', 'twice_daily', 'daily', 'manual']).optional(),
});

type Params = { params: Promise<{ id: string }> };

export const PATCH = route(async (request: Request, { params }: Params) => {
  const { user, run } = await requireTenant();
  const { id } = await params;
  const body = patchSchema.parse(await request.json());

  const agent = await run(async (tx) => {
    const existing = await tx.agent.findFirst({ where: { id, userId: user.id } });
    if (!existing) return null;
    return tx.agent.update({ where: { id }, data: body });
  });
  if (!agent) return fail('Agent not found.', 404);
  return ok({ agent });
});

export const DELETE = route(async (_request: Request, { params }: Params) => {
  const { user, run } = await requireTenant();
  const { id } = await params;

  const deleted = await run(async (tx) => {
    const existing = await tx.agent.findFirst({ where: { id, userId: user.id } });
    if (!existing) return false;
    await tx.agent.delete({ where: { id } });
    return true;
  });
  if (!deleted) return fail('Agent not found.', 404);
  return ok({ ok: true });
});
