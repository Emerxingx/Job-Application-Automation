import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { staffingFail, staffingRequest } from '@/lib/staffing/request';
import { FELL_OFF_REASONS, updatePlacementStatus } from '@/lib/staffing/service';

const schema = z.object({ organizationId: z.string().min(1), status: z.enum(['started', 'completed', 'fell_off', 'cancelled']), fellOffReason: z.enum(FELL_OFF_REASONS).optional(), fellOffAt: z.coerce.date().optional() });

/** PATCH /api/staffing/placements/:id - pending -> started -> completed; a started placement may fall off (with a reason and a date on or after the start); a pending one may be cancelled. */
export const PATCH = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = schema.parse(await request.json());
  try {
    const { tenant, actor } = await staffingRequest(request, body.organizationId);
    const p = await tenant.run((tx) => updatePlacementStatus(tx, actor, id, body));
    return ok({ placement: { id: p.id, status: p.status } });
  } catch (error) {
    return staffingFail(error) ?? Promise.reject(error);
  }
});
