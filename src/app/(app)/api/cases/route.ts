import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { caseFail, caseRequest, organizationIdOf } from '@/lib/cases/request';
import { inviteClient, listCaseload } from '@/lib/cases/service';

/** GET /api/cases?organizationId=&status= - the caseload as the caller's role sees it (Stage 17, ADR-0032). */
export const GET = route(async (request: Request) => {
  try {
    const { tenant, actor } = await caseRequest(request, organizationIdOf(request));
    const status = new URL(request.url).searchParams.get('status') ?? undefined;
    const caseload = await tenant.run((tx) => listCaseload(tx, actor, { status }));
    return ok({ role: actor.role, ...caseload });
  } catch (error) {
    return caseFail(error) ?? Promise.reject(error);
  }
});

const inviteSchema = z.object({
  organizationId: z.string().min(1),
  email: z.string().email(),
  caseManagerId: z.string().min(1).nullable().optional(),
  employmentGoal: z.string().trim().max(500).optional(),
});

/** POST /api/cases - invite a client (supervisor or admin). The case holds nothing until the client accepts. */
export const POST = route(async (request: Request) => {
  const body = inviteSchema.parse(await request.json());
  try {
    const { actor } = await caseRequest(request, body.organizationId);
    const c = await inviteClient(actor, body);
    return ok({ case: { id: c.id, status: c.status } }, { status: 201 });
  } catch (error) {
    return caseFail(error) ?? Promise.reject(error);
  }
});
