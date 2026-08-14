import { requireUser } from '@/lib/auth';
import { fail, ok, route } from '@/lib/api';
import {
  getInvoiceForUser,
  invoiceBalance,
  invoiceTaxSummary,
  isIssuedDocument,
  readBillTo,
  readSeller,
} from '@/lib/billing/invoice';

type Params = { params: Promise<{ id: string }> };

/**
 * One invoice, with its line items and tax breakdown.
 *
 * Ownership is enforced in the query itself (`findFirst({ id, userId })`), not
 * by loading the row and comparing afterwards — the two are equivalent only
 * until someone adds an early return above the check. A row belonging to
 * another customer produces the same 404 as a row that does not exist, so the
 * endpoint never confirms that an invoice id is real.
 */
export const GET = route(async (_request: Request, { params }: Params) => {
  const user = await requireUser();
  const { id } = await params;

  const invoice = await getInvoiceForUser(id, user.id);
  if (!invoice) return fail('Invoice not found.', 404);

  // A draft is not a document yet: unnumbered, still mutable, never delivered.
  // A draft that was discarded is `void` and equally has no number.
  if (!isIssuedDocument(invoice)) return fail('Invoice not found.', 404);

  return ok({
    invoice: {
      id: invoice.id,
      number: invoice.number,
      status: invoice.status,
      currency: invoice.currency,
      collectionMethod: invoice.collectionMethod,
      planCode: invoice.planCode,
      planName: invoice.planName,
      interval: invoice.interval,
      issuedAt: invoice.issuedAt,
      dueAt: invoice.dueAt,
      paidAt: invoice.paidAt,
      voidedAt: invoice.voidedAt,
      voidReason: invoice.voidReason,
      periodStart: invoice.periodStart,
      periodEnd: invoice.periodEnd,
      subtotalCents: invoice.subtotalCents,
      discountCents: invoice.discountCents,
      taxCents: invoice.taxCents,
      totalCents: invoice.totalCents,
      balance: invoiceBalance(invoice),
      notes: invoice.notes,
      footer: invoice.footer,
      // Snapshots, not live lookups — this is what the PDF prints.
      billTo: readBillTo(invoice),
      seller: readSeller(invoice),
      lines: invoice.lines.map((line) => ({
        id: line.id,
        kind: line.kind,
        description: line.description,
        quantity: line.quantity,
        unitAmountCents: line.unitAmountCents,
        subtotalCents: line.subtotalCents,
        taxCents: line.taxCents,
        totalCents: line.totalCents,
        periodStart: line.periodStart,
        periodEnd: line.periodEnd,
      })),
      taxes: invoiceTaxSummary(invoice.taxLines),
      pdfUrl: `/api/invoices/${invoice.id}/pdf`,
    },
  });
});
