import { z } from 'zod';
import { ok, route } from '@/lib/api';
import { staffingFail, staffingRequest } from '@/lib/staffing/request';
import { INVOICE_VOID_REASONS, updatePlacementInvoice } from '@/lib/staffing/service';

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('paid'), organizationId: z.string().min(1) }),
  z.object({ action: z.literal('void'), organizationId: z.string().min(1), reason: z.enum(INVOICE_VOID_REASONS) }),
  z.object({ action: z.literal('credit_guarantee'), organizationId: z.string().min(1) }),
]);

/** PATCH /api/staffing/invoices/:id - paid, void (with a reason), or a guarantee credit after a fall-off inside the guarantee. */
export const PATCH = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = schema.parse(await request.json());
  try {
    const { tenant, actor } = await staffingRequest(request, body.organizationId);
    const inv = await tenant.run((tx) => updatePlacementInvoice(tx, actor, id, body));
    return ok({ invoice: { id: inv.id, status: inv.status, creditedCents: inv.creditedCents } });
  } catch (error) {
    return staffingFail(error) ?? Promise.reject(error);
  }
});
