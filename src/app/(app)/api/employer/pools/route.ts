import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { employerFail, employerRequest, organizationIdOf } from '@/lib/employer/request';
import { createPool, listPools } from '@/lib/employer/service';

/** GET /api/employer/pools?organizationId= - the organisation's talent pools with member counts. */
export const GET = route(async (request: Request) => {
  try {
    const { tenant, actor } = await employerRequest(request, organizationIdOf(request));
    const pools = await tenant.run((tx) => listPools(tx, actor));
    return ok({ pools: pools.map((p) => ({ id: p.id, name: p.name, description: p.description, members: p._count.members })) });
  } catch (error) {
    return employerFail(error) ?? Promise.reject(error);
  }
});

const schema = z.object({ organizationId: z.string().min(1), name: z.string().trim().min(2).max(120), description: z.string().trim().max(500).optional() });

/** POST /api/employer/pools - create a talent pool (recruiter, admin). A pool holds consented candidates only. */
export const POST = route(async (request: Request) => {
  const body = schema.parse(await request.json());
  try {
    const { tenant, actor } = await employerRequest(request, body.organizationId);
    const p = await tenant.run((tx) => createPool(tx, actor, body));
    return ok({ pool: { id: p.id } }, { status: 201 });
  } catch (error) {
    return employerFail(error) ?? Promise.reject(error);
  }
});
