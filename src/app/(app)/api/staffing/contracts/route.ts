import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { organizationIdOf, staffingFail, staffingRequest } from '@/lib/staffing/request';
import { createContract, listContracts } from '@/lib/staffing/service';

/** GET /api/staffing/contracts?organizationId= - the agency's client contracts (Stage 19, ADR-0034). */
export const GET = route(async (request: Request) => {
  try {
    const { tenant, actor } = await staffingRequest(request, organizationIdOf(request));
    const rows = await tenant.run((tx) => listContracts(tx, actor));
    return ok({ role: actor.role, contracts: rows.map((c) => ({ id: c.id, clientName: c.clientName, jurisdiction: c.jurisdiction, status: c.status, agencyLicenceRef: c.agencyLicenceRef, engagements: c._count.engagements })) });
  } catch (error) {
    return staffingFail(error) ?? Promise.reject(error);
  }
});

const schema = z.object({ organizationId: z.string().min(1), clientName: z.string().trim().min(2).max(160), clientContactEmail: z.string().email().optional(), jurisdiction: z.string().trim().min(2).max(6), terms: z.string().trim().max(20_000).optional(), agencyLicenceRef: z.string().trim().max(120).optional(), startsAt: z.coerce.date().nullable().optional(), endsAt: z.coerce.date().nullable().optional() });

/** POST /api/staffing/contracts - an administrator records a client contract (draft until activated). */
export const POST = route(async (request: Request) => {
  const body = schema.parse(await request.json());
  try {
    const { tenant, actor } = await staffingRequest(request, body.organizationId);
    const c = await tenant.run((tx) => createContract(tx, actor, body));
    return ok({ contract: { id: c.id, status: c.status } }, { status: 201 });
  } catch (error) {
    return staffingFail(error) ?? Promise.reject(error);
  }
});
