import { z } from 'zod';
import { requireTenant } from '@/lib/tenancy/request';
import { fail, ok, route } from '@/lib/api';
import { CareerAccessError, CareerError, analysisBudget, createCareerPlan, listPlans } from '@/lib/career/service';

/**
 * Stage 16 (ADR-0031). GET /api/career/plans - the person's current plans
 * and how many new analyses their entitlement still allows this window.
 */
export const GET = route(async () => {
  const { user, run } = await requireTenant();
  const { plans, budget } = await run(async (tx) => ({ plans: await listPlans(tx, user.id), budget: await analysisBudget(tx, user.id) }));
  return ok({ plans, budget });
});

const createSchema = z.object({
  targetOccupationId: z.string().min(1),
  currentOccupationId: z.string().min(1).nullable().optional(),
  title: z.string().trim().max(120).optional(),
});

/**
 * POST /api/career/plans - run the engine against a target occupation and
 * store the result as plan version 1 with its milestones. Refused (403) when
 * the `career_transition_per_month` entitlement is spent or absent.
 */
export const POST = route(async (request: Request) => {
  const { user, run } = await requireTenant();
  const body = createSchema.parse(await request.json());
  try {
    const plan = await run((tx) => createCareerPlan(tx, user.id, body));
    return ok({ plan: { id: plan.id, version: plan.version, title: plan.title } }, { status: 201 });
  } catch (error) {
    if (error instanceof CareerAccessError || error instanceof CareerError) return fail(error.message, error.status);
    throw error;
  }
});
