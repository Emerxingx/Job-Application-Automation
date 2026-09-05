import { z } from 'zod';
import { requireTenant } from '@/lib/tenancy/request';
import { fail, ok, route } from '@/lib/api';
import { CareerError, MILESTONE_STATUSES, updateMilestone } from '@/lib/career/service';

const schema = z.object({
  status: z.enum(MILESTONE_STATUSES),
  /** An APPROVED evidence claim of the person's own vault that backs a completed milestone; null clears it. */
  evidenceId: z.string().min(1).nullable().optional(),
  note: z.string().trim().max(500).optional(),
});

/** PATCH /api/career/milestones/:id - move a milestone; `done` may cite approved evidence (Stage 03), never an unbacked claim as proof. */
export const PATCH = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { user, run } = await requireTenant();
  const { id } = await params;
  const body = schema.parse(await request.json());
  try {
    const milestone = await run((tx) => updateMilestone(tx, user.id, id, body));
    return ok({ milestone: { id: milestone.id, status: milestone.status, completedAt: milestone.completedAt?.toISOString() ?? null, evidenceId: milestone.evidenceId, note: milestone.note } });
  } catch (error) {
    if (error instanceof CareerError) return fail(error.message, error.status);
    throw error;
  }
});
