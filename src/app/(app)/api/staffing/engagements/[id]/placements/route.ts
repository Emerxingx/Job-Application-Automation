import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { staffingFail, staffingRequest } from '@/lib/staffing/request';
import { createPlacement } from '@/lib/staffing/service';

const schema = z.object({ organizationId: z.string().min(1), representationConsentId: z.string().min(1), startDate: z.coerce.date(), salaryCents: z.number().int().positive(), currency: z.enum(['CAD', 'USD']).optional(), recruiterId: z.string().min(1).nullable().optional() });

/** POST /api/staffing/engagements/:id/placements - place a represented candidate; the fee is frozen and the jurisdiction evaluation stored. */
export const POST = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = schema.parse(await request.json());
  try {
    const { tenant, actor } = await staffingRequest(request, body.organizationId);
    const p = await tenant.run((tx) => createPlacement(tx, actor, { engagementId: id, ...body }));
    return ok({ placement: { id: p.id, status: p.status, feeCents: p.feeCents, guaranteeEndsAt: p.guaranteeEndsAt } }, { status: 201 });
  } catch (error) {
    return staffingFail(error) ?? Promise.reject(error);
  }
});
