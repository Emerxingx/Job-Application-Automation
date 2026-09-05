import { ok, route } from '@/lib/api';
import { organizationIdOf, staffingFail, staffingRequest } from '@/lib/staffing/request';
import { listPlacementInvoices } from '@/lib/staffing/service';

/** GET /api/staffing/invoices?organizationId= - the agency's placement invoices (finance, admin). */
export const GET = route(async (request: Request) => {
  try {
    const { tenant, actor } = await staffingRequest(request, organizationIdOf(request));
    const rows = await tenant.run((tx) => listPlacementInvoices(tx, actor));
    return ok({ invoices: rows.map((i) => ({ id: i.id, number: i.number, status: i.status, amountCents: i.amountCents, creditedCents: i.creditedCents, currency: i.currency, clientName: i.contract.clientName, issuedAt: i.issuedAt, dueAt: i.dueAt, paidAt: i.paidAt })) });
  } catch (error) {
    return staffingFail(error) ?? Promise.reject(error);
  }
});
