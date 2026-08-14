import { z } from 'zod';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';
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
  const user = await requireUser();
  const { id } = await params;
  const body = patchSchema.parse(await request.json());

  const existing = await db.agent.findFirst({ where: { id, userId: user.id } });
  if (!existing) return fail('Agent not found.', 404);

  const agent = await db.agent.update({ where: { id }, data: body });
  return ok({ agent });
});

export const DELETE = route(async (_request: Request, { params }: Params) => {
  const user = await requireUser();
  const { id } = await params;

  const existing = await db.agent.findFirst({ where: { id, userId: user.id } });
  if (!existing) return fail('Agent not found.', 404);

  await db.agent.delete({ where: { id } });
  return ok({ ok: true });
});
