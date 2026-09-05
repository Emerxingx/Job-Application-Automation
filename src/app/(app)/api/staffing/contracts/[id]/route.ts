import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { staffingFail, staffingRequest } from '@/lib/staffing/request';
import { CONTRACT_STATUSES, setContractStatus } from '@/lib/staffing/service';

const schema = z.object({ organizationId: z.string().min(1), status: z.enum(CONTRACT_STATUSES) });

/** PATCH /api/staffing/contracts/:id - draft -> active -> ended. */
export const PATCH = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = schema.parse(await request.json());
  try {
    const { tenant, actor } = await staffingRequest(request, body.organizationId);
    const c = await tenant.run((tx) => setContractStatus(tx, actor, id, body.status));
    return ok({ contract: { id: c.id, status: c.status } });
  } catch (error) {
    return staffingFail(error) ?? Promise.reject(error);
  }
});
