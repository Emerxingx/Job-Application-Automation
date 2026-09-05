import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { caseFail, caseRequest } from '@/lib/cases/request';
import { OUTCOME_KINDS, recordOutcome } from '@/lib/cases/service';

const schema = z.object({
  organizationId: z.string().min(1),
  kind: z.enum(OUTCOME_KINDS),
  employerName: z.string().trim().max(200).optional(),
  startDate: z.coerce.date().nullable().optional(),
  hoursPerWeek: z.number().int().min(0).max(168).nullable().optional(),
  note: z.string().trim().max(1000).optional(),
});

/** POST /api/cases/:caseId/outcomes - an employment outcome; retention follow-ups are created for an employed / training outcome. */
export const POST = route(async (request: Request, { params }: { params: Promise<{ caseId: string }> }) => {
  const { caseId } = await params;
  const body = schema.parse(await request.json());
  try {
    const { tenant, actor } = await caseRequest(request, body.organizationId);
    const outcome = await tenant.run((tx) => recordOutcome(tx, actor, caseId, body));
    return ok({ outcome }, { status: 201 });
  } catch (error) {
    return caseFail(error) ?? Promise.reject(error);
  }
});
