import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { staffingFail, staffingRequest } from '@/lib/staffing/request';
import { issuePlacementInvoice } from '@/lib/staffing/service';

const schema = z.object({ organizationId: z.string().min(1), dueDays: z.number().int().min(1).max(365).optional() });

/** POST /api/staffing/placements/:id/invoices - finance issues the client's invoice (PL- series); refused unless the jurisdiction's rules are recorded and pass. */
export const POST = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = schema.parse(await request.json());
  try {
    const { tenant, actor } = await staffingRequest(request, body.organizationId);
    const inv = await tenant.run((tx) => issuePlacementInvoice(tx, actor, id, body));
    return ok({ invoice: { id: inv.id, number: inv.number, status: inv.status, amountCents: inv.amountCents, currency: inv.currency } }, { status: 201 });
  } catch (error) {
    return staffingFail(error) ?? Promise.reject(error);
  }
});
