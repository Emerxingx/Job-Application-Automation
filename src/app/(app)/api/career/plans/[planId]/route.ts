import { z } from 'zod';
import { requireTenant } from '@/lib/tenancy/request';
import { fail, ok, route } from '@/lib/api';
import { CareerAccessError, CareerError, archiveCareerPlan, loadPlan, refreshCareerPlan } from '@/lib/career/service';

/** GET /api/career/plans/:planId - one plan version with its analysis and milestones (the owner's only). */
export const GET = route(async (_request: Request, { params }: { params: Promise<{ planId: string }> }) => {
  const { user, run } = await requireTenant();
  const { planId } = await params;
  const plan = await run((tx) => loadPlan(tx, user.id, planId));
  if (!plan) return fail('No such plan.', 404);
  return ok({ plan });
});

const actionSchema = z.discriminatedUnion('action', [z.object({ action: z.literal('refresh') }), z.object({ action: z.literal('archive') })]);

/**
 * PATCH /api/career/plans/:planId - `refresh` re-runs the engine as a NEW
 * version that supersedes this one (progress carried by milestone title);
 * `archive` retires it. A plan version is never edited in place.
 */
export const PATCH = route(async (request: Request, { params }: { params: Promise<{ planId: string }> }) => {
  const { user, run } = await requireTenant();
  const { planId } = await params;
  const body = actionSchema.parse(await request.json());
  try {
    if (body.action === 'archive') {
      const archived = await run((tx) => archiveCareerPlan(tx, user.id, planId));
      if (!archived) return fail('No such plan, or it is already archived.', 404);
      return ok({ archived: true });
    }
    const next = await run((tx) => refreshCareerPlan(tx, user.id, planId));
    return ok({ plan: { id: next.id, version: next.version, supersedesId: next.supersedesId } });
  } catch (error) {
    if (error instanceof CareerAccessError || error instanceof CareerError) return fail(error.message, error.status);
    throw error;
  }
});
