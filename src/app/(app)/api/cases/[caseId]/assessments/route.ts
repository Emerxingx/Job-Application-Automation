import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { caseFail, caseRequest, organizationIdOf } from '@/lib/cases/request';
import { ASSESSMENT_KINDS, addAssessment, listAssessments } from '@/lib/cases/service';

type Params = { params: Promise<{ caseId: string }> };

/** GET /api/cases/:caseId/assessments?organizationId= - RESTRICTED; audited before the read. */
export const GET = route(async (request: Request, { params }: Params) => {
  const { caseId } = await params;
  try {
    const { tenant, actor } = await caseRequest(request, organizationIdOf(request));
    const rows = await tenant.run((tx) => listAssessments(tx, actor, caseId));
    return ok({ assessments: rows.map((a) => ({ id: a.id, kind: a.kind, summary: a.summary, barriers: JSON.parse(a.barriers) as string[], employmentGoal: a.employmentGoal, createdAt: a.createdAt })) });
  } catch (error) {
    return caseFail(error) ?? Promise.reject(error);
  }
});

const schema = z.object({
  organizationId: z.string().min(1),
  kind: z.enum(ASSESSMENT_KINDS),
  summary: z.string().trim().max(5000),
  barriers: z.array(z.string().trim().min(1).max(120)).max(20),
  employmentGoal: z.string().trim().max(500).optional(),
});

export const POST = route(async (request: Request, { params }: Params) => {
  const { caseId } = await params;
  const body = schema.parse(await request.json());
  try {
    const { tenant, actor } = await caseRequest(request, body.organizationId);
    const row = await tenant.run((tx) => addAssessment(tx, actor, caseId, body));
    return ok({ assessment: { id: row.id, createdAt: row.createdAt } }, { status: 201 });
  } catch (error) {
    return caseFail(error) ?? Promise.reject(error);
  }
});
