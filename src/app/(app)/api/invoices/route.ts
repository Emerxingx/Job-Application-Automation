import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { ok, route } from '@/lib/api';
import { invoiceBalance, listInvoicesForUser, invoiceTaxSummary } from '@/lib/billing/invoice';
import type { InvoiceStatus } from '@/lib/billing/invoice';

const query = z.object({
  status: z.enum(['open', 'paid', 'void', 'uncollectible']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).optional(),
});

/**
 * The current user's invoices, newest first.
 *
 * Drafts are excluded: a draft has no number, no issue date and is still
 * mutable — it is not a document the customer has been given, and showing one
 * invites a support ticket about a charge that has not happened. `status` is
 * deliberately not allowed to select drafts either.
 */
export const GET = route(async (request: Request) => {
  const user = await requireUser();
  const url = new URL(request.url);
  const params = query.parse(Object.fromEntries(url.searchParams));

  const invoices = await listInvoicesForUser(user.id, {
    status: params.status as InvoiceStatus | undefined,
    limit: params.limit,
    cursor: params.cursor,
  });

  return ok({
    invoices: invoices.map((invoice) => ({
      id: invoice.id,
      number: invoice.number,
      status: invoice.status,
      currency: invoice.currency,
      planName: invoice.planName,
      interval: invoice.interval,
      issuedAt: invoice.issuedAt,
      dueAt: invoice.dueAt,
      paidAt: invoice.paidAt,
      periodStart: invoice.periodStart,
      periodEnd: invoice.periodEnd,
      subtotalCents: invoice.subtotalCents,
      discountCents: invoice.discountCents,
      taxCents: invoice.taxCents,
      totalCents: invoice.totalCents,
      balance: invoiceBalance(invoice),
      taxes: invoiceTaxSummary(invoice.taxLines),
      lineCount: invoice.lines.length,
      pdfUrl: `/api/invoices/${invoice.id}/pdf`,
    })),
    // Cursor pagination: pass the last id back as `cursor`.
    nextCursor: invoices.length > 0 ? invoices[invoices.length - 1].id : null,
  });
});
