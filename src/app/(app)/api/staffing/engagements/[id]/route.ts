import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { organizationIdOf, staffingFail, staffingRequest } from '@/lib/staffing/request';
import { ENGAGEMENT_STATUSES, loadEngagement, setEngagementStatus } from '@/lib/staffing/service';

type Params = { params: Promise<{ id: string }> };

/** GET /api/staffing/engagements/:id?organizationId= - the engagement, its jurisdiction evaluation, representations (identity only when granted), placements and invoices (as the role may see them). */
export const GET = route(async (request: Request, { params }: Params) => {
  const { id } = await params;
  try {
    const { tenant, actor } = await staffingRequest(request, organizationIdOf(request));
    return ok(await tenant.run((tx) => loadEngagement(tx, actor, id)));
  } catch (error) {
    return staffingFail(error) ?? Promise.reject(error);
  }
});

const schema = z.object({ organizationId: z.string().min(1), status: z.enum(ENGAGEMENT_STATUSES) });

/** PATCH /api/staffing/engagements/:id - draft -> active (needs an active contract) -> filled | closed. */
export const PATCH = route(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const body = schema.parse(await request.json());
  try {
    const { tenant, actor } = await staffingRequest(request, body.organizationId);
    const e = await tenant.run((tx) => setEngagementStatus(tx, actor, id, body.status));
    return ok({ engagement: { id: e.id, status: e.status } });
  } catch (error) {
    return staffingFail(error) ?? Promise.reject(error);
  }
});
