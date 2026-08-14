import { db } from '@/lib/db';
import { fail } from '@/lib/api';
import { consoleRoute, requireStaff } from '@/lib/crm/auth';
import { isIssuedDocument } from '@/lib/billing/invoice';
import { invoicePdfInputFrom, renderAndFingerprintInvoicePdf } from '@/lib/billing/invoice-pdf';

type Params = { params: Promise<{ id: string }> };

/**
 * The staff copy of an invoice PDF.
 *
 * The customer-facing route at /api/invoices/:id/pdf scopes to
 * `requireUser()`'s own id, which is correct there and useless here: support
 * needs the document for somebody else's account. This route is the same
 * renderer with a different gate — `requireStaff('billing_ops')` — and it lives
 * under /console because it is a console capability, not a public one.
 *
 * IT DOES NOT INHERIT THE SECTION LAYOUT'S CHECK. Route Handlers never run
 * layouts, so if this file forgot `requireStaff()` it would serve any
 * customer's invoice to anyone with a session. That is the reason the gate is
 * written out here rather than assumed.
 *
 * Bytes are rendered on demand from the invoice's frozen snapshots — the
 * bill-to address and tax lines as they were at issue, never today's rate table
 * — so the same invoice always produces the same document, which is what makes
 * the sha256 a sound ETag.
 */
export const GET = consoleRoute(async (request: Request, { params }: Params) => {
  const staff = await requireStaff('billing_ops');
  const { id } = await params;

  const invoice = await db.invoice.findUnique({
    where: { id },
    include: { lines: { orderBy: { sortOrder: 'asc' } }, taxLines: true },
  });
  if (!invoice) return fail('Invoice not found.', 404);

  // A draft has no number and is still mutable. There is no document to hand
  // over yet, and issuing one is a billing action rather than a download.
  if (!isIssuedDocument(invoice)) {
    return fail('This invoice has not been issued yet, so it has no document.', 409);
  }

  const { buffer, sha256 } = await renderAndFingerprintInvoicePdf(invoicePdfInputFrom(invoice));

  const etag = `"${sha256}"`;
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  // A staff member pulling another person's financial document is worth a row.
  // Reads are not audited across the console in general — a row per denial or
  // per list view would let noise crowd out the entries that matter — but this
  // one is a deliberate, low-volume act against a specific customer's money.
  await db.auditLog.create({
    data: {
      actorType: 'staff',
      actorId: staff.id,
      actorEmail: staff.email,
      actorRole: staff.role,
      action: 'invoice.pdf.download',
      entityType: 'Invoice',
      entityId: invoice.id,
      summary: `${staff.email} downloaded invoice ${invoice.number}`,
      changedFields: JSON.stringify([]),
    },
  });

  const fileName = `${invoice.number ?? `invoice-${invoice.id}`}.pdf`;

  // Copy into a plain Uint8Array: `Response` wants a BodyInit, and a Buffer
  // backed by Node's shared pool can otherwise expose neighbouring bytes.
  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(buffer.byteLength),
      'Content-Disposition': `attachment; filename="${fileName}"`,
      // Somebody else's invoice must never sit in a shared cache.
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      ETag: etag,
    },
  });
});
