import { requireUser } from '@/lib/auth';
import { fail, route } from '@/lib/api';
import { getInvoiceForUser, isIssuedDocument } from '@/lib/billing/invoice';
import { invoicePdfInputFrom, renderAndFingerprintInvoicePdf } from '@/lib/billing/invoice-pdf';

type Params = { params: Promise<{ id: string }> };

/**
 * Download an invoice as a PDF.
 *
 * Rendered on demand from the invoice's frozen snapshots, so the bytes are
 * reproducible: the same invoice always renders the same document, which is
 * why the sha256 makes a sound ETag. Nothing here reads the live rate table or
 * the current billing profile.
 */
export const GET = route(async (request: Request, { params }: Params) => {
  const user = await requireUser();
  const { id } = await params;

  const invoice = await getInvoiceForUser(id, user.id);
  if (!invoice) return fail('Invoice not found.', 404);

  // An unissued invoice carries no number and is still mutable — there is no
  // document to hand over yet, and issuing one is a billing action, not a
  // download.
  if (!isIssuedDocument(invoice)) {
    return fail('This invoice has not been issued yet.', 409);
  }

  const { buffer, sha256 } = await renderAndFingerprintInvoicePdf(invoicePdfInputFrom(invoice));

  const etag = `"${sha256}"`;
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  const fileName = `${invoice.number ?? `invoice-${invoice.id}`}.pdf`;

  // Buffer -> Uint8Array copy: Response wants a plain BodyInit, and a Buffer
  // backed by a pooled ArrayBuffer can otherwise expose neighbouring bytes.
  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(buffer.byteLength),
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Cache-Control': 'private, no-store',
      ETag: etag,
    },
  });
});
