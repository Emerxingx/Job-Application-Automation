import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { organizationIdOf, staffingFail, staffingRequest } from '@/lib/staffing/request';
import { createEngagement, listEngagements } from '@/lib/staffing/service';

/** GET /api/staffing/engagements?organizationId= */
export const GET = route(async (request: Request) => {
  try {
    const { tenant, actor } = await staffingRequest(request, organizationIdOf(request));
    const rows = await tenant.run((tx) => listEngagements(tx, actor));
    return ok({ role: actor.role, engagements: rows.map((e) => ({ id: e.id, title: e.title, status: e.status, jurisdiction: e.jurisdiction, clientName: e.contract.clientName, ownerRecruiterId: e.ownerRecruiterId, representations: e._count.representations, placements: e._count.placements, updatedAt: e.updatedAt })) });
  } catch (error) {
    return staffingFail(error) ?? Promise.reject(error);
  }
});

const schema = z.object({ organizationId: z.string().min(1), contractId: z.string().min(1), feeStructureId: z.string().min(1), title: z.string().trim().min(2).max(160), description: z.string().trim().max(20_000).optional(), ownerRecruiterId: z.string().min(1).nullable().optional() });

/** POST /api/staffing/engagements - open an engagement under a contract with a fee structure (draft until activated). */
export const POST = route(async (request: Request) => {
  const body = schema.parse(await request.json());
  try {
    const { tenant, actor } = await staffingRequest(request, body.organizationId);
    const e = await tenant.run((tx) => createEngagement(tx, actor, body));
    return ok({ engagement: { id: e.id, status: e.status } }, { status: 201 });
  } catch (error) {
    return staffingFail(error) ?? Promise.reject(error);
  }
});
