import { createHash } from 'node:crypto';
// pdfkit's default entry loads its standard-font metrics at runtime with
// `fs.readFileSync(__dirname + '/data/Helvetica.afm')`. That is fine under
// plain node, but Next bundles route handlers by default and pdfkit is not on
// Next's built-in external list — inside the bundle `__dirname` resolves into
// `.next/server/...`, the .afm files are not there, and every render dies on
// ENOENT. The standalone build is the same library with the font metrics
// inlined in a virtual filesystem and no `fs` access at all, so it survives
// bundling unchanged. (The other fix is adding 'pdfkit' to
// `serverExternalPackages` in next.config.mjs, which this module must not
// depend on being done.)
// @ts-expect-error — the standalone bundle ships no declarations of its own;
// @types/pdfkit describes the identical API and is applied on the next line.
import PDFDocumentStandalone from 'pdfkit/js/pdfkit.standalone.js';
import {
  invoiceTaxSummary,
  readBillTo,
  readSeller,
  type BillToSnapshot,
  type SellerSnapshot,
} from './invoice';

const PDFDocument = PDFDocumentStandalone as unknown as typeof import('pdfkit');

/**
 * Invoice PDF rendering.
 *
 * The renderer takes a plain data structure, never a live query. Everything it
 * prints — the seller's address, the customer's address, the tax rate beside
 * each component, the registration number — comes from the snapshots frozen
 * onto the invoice when it was issued. Re-rendering a 2024 invoice in 2026 must
 * reproduce 2024's document exactly; a renderer that reads the rate table or
 * the billing profile live would quietly reissue history at today's values.
 *
 * Layout is absolute-positioned rather than flowed: every column has a fixed x
 * and width, money is right-aligned in its column, and row heights are measured
 * from the wrapped description so nothing overlaps when a line item runs long.
 */

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface InvoicePdfLine {
  description: string;
  quantity: number;
  unitAmountCents: number;
  subtotalCents: number;
  periodStart?: Date | null;
  periodEnd?: Date | null;
}

export interface InvoicePdfTaxLine {
  label: string;
  jurisdiction: string;
  amountCents: number;
  registrationNumber?: string | null;
}

export interface InvoicePdfInput {
  number: string | null;
  status: string;
  currency: string;
  issuedAt?: Date | null;
  dueAt?: Date | null;
  paidAt?: Date | null;
  voidedAt?: Date | null;
  voidReason?: string | null;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  planName?: string;
  interval?: string;
  seller: SellerSnapshot;
  billTo: BillToSnapshot;
  lines: InvoicePdfLine[];
  taxLines: InvoicePdfTaxLine[];
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  amountPaidCents: number;
  amountCreditedCents: number;
  amountDueCents: number;
  notes?: string;
  footer?: string;
}

/** The persisted shape this renderer accepts, so a route can hand over a row. */
export interface InvoiceRecordForPdf {
  number: string | null;
  status: string;
  currency: string;
  issuedAt: Date | null;
  dueAt: Date | null;
  paidAt: Date | null;
  voidedAt: Date | null;
  voidReason: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  planName: string;
  interval: string;
  billToSnapshot: string;
  sellerSnapshot: string;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  amountPaidCents: number;
  amountCreditedCents: number;
  amountDueCents: number;
  notes: string;
  footer: string;
  lines: {
    description: string;
    quantity: number;
    unitAmountCents: number;
    subtotalCents: number;
    periodStart: Date | null;
    periodEnd: Date | null;
    sortOrder: number;
  }[];
  taxLines: {
    code: string;
    label: string;
    jurisdiction: string;
    rateParts: number;
    taxableCents: number;
    amountCents: number;
    registrationNumber: string | null;
  }[];
}

/** Map a persisted invoice (with lines and tax lines) into renderer input. */
export function invoicePdfInputFrom(invoice: InvoiceRecordForPdf): InvoicePdfInput {
  return {
    number: invoice.number,
    status: invoice.status,
    currency: invoice.currency,
    issuedAt: invoice.issuedAt,
    dueAt: invoice.dueAt,
    paidAt: invoice.paidAt,
    voidedAt: invoice.voidedAt,
    voidReason: invoice.voidReason,
    periodStart: invoice.periodStart,
    periodEnd: invoice.periodEnd,
    planName: invoice.planName,
    interval: invoice.interval,
    seller: readSeller(invoice),
    billTo: readBillTo(invoice),
    lines: [...invoice.lines]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((line) => ({
        description: line.description,
        quantity: line.quantity,
        unitAmountCents: line.unitAmountCents,
        subtotalCents: line.subtotalCents,
        periodStart: line.periodStart,
        periodEnd: line.periodEnd,
      })),
    // Grouped: a customer reads one "HST (13%)" row, not one per line item.
    taxLines: invoiceTaxSummary(invoice.taxLines).map((tax) => ({
      label: tax.label,
      jurisdiction: tax.jurisdiction,
      amountCents: tax.amountCents,
      registrationNumber: tax.registrationNumber,
    })),
    subtotalCents: invoice.subtotalCents,
    discountCents: invoice.discountCents,
    taxCents: invoice.taxCents,
    totalCents: invoice.totalCents,
    amountPaidCents: invoice.amountPaidCents,
    amountCreditedCents: invoice.amountCreditedCents,
    amountDueCents: invoice.amountDueCents,
    notes: invoice.notes,
    footer: invoice.footer,
  };
}

// ---------------------------------------------------------------------------
// Geometry and palette
// ---------------------------------------------------------------------------

const PAGE = { width: 612, height: 792 };
const MARGIN = 50;
const RIGHT = PAGE.width - MARGIN; // 562
const CONTENT_WIDTH = RIGHT - MARGIN; // 512
const FOOTER_RESERVE = 78;

/** Fixed columns. Widths are chosen so every right edge lands exactly on 562. */
const COL = {
  description: { x: MARGIN, width: 250 }, //  50 .. 300
  quantity: { x: 306, width: 40 }, // 306 .. 346, right aligned
  unit: { x: 352, width: 100 }, // 352 .. 452, right aligned
  amount: { x: 458, width: 104 }, // 458 .. 562, right aligned
} as const;

/** Totals use the last two columns so the numbers line up with the table. */
const TOTALS_LABEL = { x: 300, width: 152 };
const TOTALS_VALUE = { x: 458, width: 104 };

const INK = '#111827';
const MUTED = '#6b7280';
const FAINT = '#9ca3af';
const LINE = '#e5e7eb';
const BRAND = '#4f46e5';
const SUCCESS = '#15803d';
const WARNING = '#b45309';
const DANGER = '#b91c1c';

type StatusStyle = { label: string; color: string; background: string };

function statusStyle(status: string, amountDueCents: number): StatusStyle {
  switch (status) {
    case 'paid':
      return { label: 'PAID', color: SUCCESS, background: '#dcfce7' };
    case 'void':
      return { label: 'VOID', color: DANGER, background: '#fee2e2' };
    case 'uncollectible':
      return { label: 'UNCOLLECTIBLE', color: DANGER, background: '#fee2e2' };
    case 'draft':
      return { label: 'DRAFT', color: MUTED, background: '#f3f4f6' };
    default:
      return amountDueCents > 0
        ? { label: 'DUE', color: WARNING, background: '#fef3c7' }
        : { label: 'OPEN', color: MUTED, background: '#f3f4f6' };
  }
}

function formatDate(date: Date | null | undefined): string {
  if (!date) return '—';
  return date.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Money for the document face. Always two decimals, always right-aligned by
 *  the caller — the currency is stated once in the meta block, not per row. */
function money(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  const dollars = Math.floor(absolute / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${dollars}.${String(absolute % 100).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

type Doc = InstanceType<typeof PDFDocument>;

/** Render the invoice and resolve with the finished PDF bytes. */
export function renderInvoicePdf(input: InvoicePdfInput): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: [PAGE.width, PAGE.height],
        margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
        bufferPages: true,
        info: {
          Title: `Invoice ${input.number ?? 'draft'}`,
          Author: input.seller.legalName,
          Subject: `Invoice for ${input.billTo.name}`,
          Creator: 'JobPilot AI',
        },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('error', reject);
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      drawDocument(doc, input);
      doc.end();
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** The PDF plus its sha256, which is what `Invoice.pdfSha256` stores and what
 *  the download route serves as an ETag. */
export async function renderAndFingerprintInvoicePdf(
  input: InvoicePdfInput,
): Promise<{ buffer: Buffer; sha256: string }> {
  const buffer = await renderInvoicePdf(input);
  return { buffer, sha256: createHash('sha256').update(buffer).digest('hex') };
}

function drawDocument(doc: Doc, input: InvoicePdfInput): void {
  if (input.status === 'void' || input.status === 'draft') {
    drawWatermark(doc, input.status.toUpperCase());
  }

  let y = drawHeader(doc, input);
  y = drawParties(doc, input, y);
  y = drawLineTable(doc, input, y);
  y = drawTotals(doc, input, y);
  drawPaymentStatus(doc, input, y);
  drawFooters(doc, input);
}

/** Drawn first so the content sits on top of it. */
function drawWatermark(doc: Doc, text: string): void {
  doc.save();
  doc.rotate(-28, { origin: [PAGE.width / 2, PAGE.height / 2] });
  doc
    .fillColor(LINE)
    .opacity(0.65)
    .font('Helvetica-Bold')
    .fontSize(96)
    .text(text, 0, PAGE.height / 2 - 60, { width: PAGE.width, align: 'center' });
  doc.opacity(1).restore();
  doc.fillColor(INK);
}

function drawHeader(doc: Doc, input: InvoicePdfInput): number {
  const top = MARGIN;

  // --- left: who is billing ---
  doc.font('Helvetica-Bold').fontSize(16).fillColor(INK);
  doc.text(input.seller.legalName, MARGIN, top, { width: 280 });

  let y = top + 22;
  doc.font('Helvetica').fontSize(9).fillColor(MUTED);
  for (const line of addressLines(input.seller)) {
    doc.text(line, MARGIN, y, { width: 280 });
    y += 12;
  }
  if (input.seller.gstNumber) {
    doc.text(`GST/HST ${input.seller.gstNumber}`, MARGIN, y, { width: 280 });
    y += 12;
  }
  if (input.seller.qstNumber) {
    doc.text(`QST ${input.seller.qstNumber}`, MARGIN, y, { width: 280 });
    y += 12;
  }

  // --- right: the document's identity ---
  doc.font('Helvetica-Bold').fontSize(26).fillColor(BRAND);
  doc.text('INVOICE', 300, top, { width: CONTENT_WIDTH - 250, align: 'right' });

  const style = statusStyle(input.status, input.amountDueCents);
  drawPill(doc, style, RIGHT, top + 34);

  let metaY = top + 60;
  const meta: [string, string][] = [
    [
      'Invoice number',
      input.number ?? (input.status === 'draft' ? 'Draft — not yet issued' : 'Never issued'),
    ],
    ['Issue date', formatDate(input.issuedAt)],
    ['Due date', formatDate(input.dueAt)],
    ['Currency', input.currency],
  ];
  if (input.periodStart && input.periodEnd) {
    meta.push(['Service period', `${formatDate(input.periodStart)} – ${formatDate(input.periodEnd)}`]);
  }

  for (const [label, value] of meta) {
    doc.font('Helvetica').fontSize(9).fillColor(FAINT);
    doc.text(label, 300, metaY, { width: 110, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK);
    doc.text(value, 416, metaY, { width: RIGHT - 416, align: 'right' });
    metaY += 14;
  }

  return Math.max(y, metaY) + 14;
}

function drawPill(doc: Doc, style: StatusStyle, rightEdge: number, y: number): void {
  doc.font('Helvetica-Bold').fontSize(9);
  const textWidth = doc.widthOfString(style.label);
  const width = textWidth + 22;
  const x = rightEdge - width;
  doc.roundedRect(x, y, width, 18, 9).fill(style.background);
  doc.fillColor(style.color).text(style.label, x, y + 5, { width, align: 'center' });
  doc.fillColor(INK);
}

function drawParties(doc: Doc, input: InvoicePdfInput, top: number): number {
  doc.moveTo(MARGIN, top).lineTo(RIGHT, top).lineWidth(1).strokeColor(LINE).stroke();
  let y = top + 16;

  doc.font('Helvetica-Bold').fontSize(9).fillColor(FAINT);
  doc.text('BILL TO', MARGIN, y, { width: 250 });

  const rightColumnX = 300;
  const showRight = Boolean(input.planName);
  if (showRight) {
    doc.text('SUBSCRIPTION', rightColumnX, y, { width: CONTENT_WIDTH - 250, align: 'right' });
  }

  y += 14;
  const startY = y;

  doc.font('Helvetica-Bold').fontSize(11).fillColor(INK);
  doc.text(input.billTo.name || '—', MARGIN, y, { width: 250 });
  y += 15;

  doc.font('Helvetica').fontSize(9).fillColor(MUTED);
  for (const line of addressLines(input.billTo)) {
    doc.text(line, MARGIN, y, { width: 250 });
    y += 12;
  }
  if (input.billTo.email) {
    doc.text(input.billTo.email, MARGIN, y, { width: 250 });
    y += 12;
  }
  if (input.billTo.taxNumber) {
    doc.text(`Tax number ${input.billTo.taxNumber}`, MARGIN, y, { width: 250 });
    y += 12;
  }
  if (input.billTo.poNumber) {
    doc.text(`PO ${input.billTo.poNumber}`, MARGIN, y, { width: 250 });
    y += 12;
  }

  let rightY = startY;
  if (showRight) {
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK);
    doc.text(input.planName ?? '', rightColumnX, rightY, {
      width: CONTENT_WIDTH - 250,
      align: 'right',
    });
    rightY += 15;
    if (input.interval) {
      doc.font('Helvetica').fontSize(9).fillColor(MUTED);
      doc.text(`Billed ${input.interval}`, rightColumnX, rightY, {
        width: CONTENT_WIDTH - 250,
        align: 'right',
      });
      rightY += 12;
    }
  }

  return Math.max(y, rightY) + 12;
}

function drawTableHeader(doc: Doc, y: number): number {
  doc.rect(MARGIN, y, CONTENT_WIDTH, 20).fill('#f9fafb');
  doc.font('Helvetica-Bold').fontSize(8).fillColor(FAINT);
  doc.text('DESCRIPTION', COL.description.x + 6, y + 6, { width: COL.description.width - 6 });
  doc.text('QTY', COL.quantity.x, y + 6, { width: COL.quantity.width, align: 'right' });
  doc.text('UNIT PRICE', COL.unit.x, y + 6, { width: COL.unit.width, align: 'right' });
  doc.text('AMOUNT', COL.amount.x, y + 6, { width: COL.amount.width - 6, align: 'right' });
  doc.fillColor(INK);
  return y + 20;
}

function drawLineTable(doc: Doc, input: InvoicePdfInput, top: number): number {
  let y = drawTableHeader(doc, top);

  for (const line of input.lines) {
    const period =
      line.periodStart && line.periodEnd
        ? `${formatDate(line.periodStart)} – ${formatDate(line.periodEnd)}`
        : '';

    // Measure before drawing so a long description never runs into the row
    // beneath it — the whole reason the table is laid out by hand.
    doc.font('Helvetica').fontSize(10);
    const descriptionHeight = doc.heightOfString(line.description, {
      width: COL.description.width - 12,
    });
    const rowHeight = Math.max(26, descriptionHeight + (period ? 24 : 14));

    if (y + rowHeight > PAGE.height - FOOTER_RESERVE) {
      doc.addPage();
      y = drawTableHeader(doc, MARGIN);
    }

    doc.font('Helvetica').fontSize(10).fillColor(INK);
    doc.text(line.description, COL.description.x + 6, y + 7, {
      width: COL.description.width - 12,
    });
    if (period) {
      doc.font('Helvetica').fontSize(8).fillColor(FAINT);
      doc.text(period, COL.description.x + 6, y + 9 + descriptionHeight, {
        width: COL.description.width - 12,
      });
    }

    doc.font('Helvetica').fontSize(10).fillColor(MUTED);
    doc.text(String(line.quantity), COL.quantity.x, y + 7, {
      width: COL.quantity.width,
      align: 'right',
    });
    doc.text(money(line.unitAmountCents), COL.unit.x, y + 7, {
      width: COL.unit.width,
      align: 'right',
    });

    doc.font('Helvetica-Bold').fontSize(10).fillColor(INK);
    doc.text(money(line.subtotalCents), COL.amount.x, y + 7, {
      width: COL.amount.width - 6,
      align: 'right',
    });

    y += rowHeight;
    doc.moveTo(MARGIN, y).lineTo(RIGHT, y).lineWidth(0.5).strokeColor(LINE).stroke();
  }

  return y + 14;
}

function drawTotalRow(
  doc: Doc,
  label: string,
  value: string,
  y: number,
  options: { bold?: boolean; color?: string; size?: number } = {},
): number {
  const size = options.size ?? 10;
  doc.font(options.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
  doc.fillColor(options.color ?? (options.bold ? INK : MUTED));
  doc.text(label, TOTALS_LABEL.x, y, { width: TOTALS_LABEL.width, align: 'right' });
  doc.fillColor(options.color ?? INK);
  doc.text(value, TOTALS_VALUE.x, y, { width: TOTALS_VALUE.width - 6, align: 'right' });
  doc.fillColor(INK);
  return y + size + 6;
}

function drawTotals(doc: Doc, input: InvoicePdfInput, top: number): number {
  const rows: { label: string; value: string; bold?: boolean; color?: string }[] = [
    { label: 'Subtotal', value: money(input.subtotalCents) },
  ];

  if (input.discountCents > 0) {
    rows.push({ label: 'Discount', value: money(-input.discountCents), color: SUCCESS });
  }

  for (const tax of input.taxLines) {
    rows.push({
      label: `${tax.label}${tax.jurisdiction ? ` · ${tax.jurisdiction}` : ''}`,
      value: money(tax.amountCents),
    });
  }

  if (input.taxLines.length === 0 && input.taxCents === 0) {
    rows.push({ label: 'Tax', value: money(0) });
  }

  // Reserve enough room that the totals block is never split across pages.
  const needed = rows.length * 16 + 70;
  let y = top;
  if (y + needed > PAGE.height - FOOTER_RESERVE) {
    doc.addPage();
    y = MARGIN;
  }

  for (const row of rows) {
    y = drawTotalRow(doc, row.label, row.value, y, { color: row.color });
  }

  y += 4;
  doc.moveTo(TOTALS_LABEL.x, y).lineTo(RIGHT, y).lineWidth(1).strokeColor(LINE).stroke();
  y += 8;

  y = drawTotalRow(doc, `Total (${input.currency})`, money(input.totalCents), y, {
    bold: true,
    size: 12,
  });

  if (input.amountPaidCents !== 0) {
    y = drawTotalRow(doc, 'Paid', money(-input.amountPaidCents), y, { color: SUCCESS });
  }
  if (input.amountCreditedCents !== 0) {
    y = drawTotalRow(doc, 'Credited', money(-input.amountCreditedCents), y, { color: SUCCESS });
  }

  y += 2;
  y = drawTotalRow(doc, 'Amount due', money(input.amountDueCents), y, {
    bold: true,
    size: 12,
    color: input.amountDueCents > 0 ? WARNING : SUCCESS,
  });

  return y + 12;
}

function drawPaymentStatus(doc: Doc, input: InvoicePdfInput, top: number): number {
  let y = top;
  const message = paymentMessage(input);
  const notes = (input.notes ?? '').trim();

  doc.font('Helvetica').fontSize(9);
  const messageHeight = doc.heightOfString(message, { width: CONTENT_WIDTH - 24 });
  const notesHeight = notes ? doc.heightOfString(notes, { width: CONTENT_WIDTH - 24 }) + 8 : 0;
  const boxHeight = messageHeight + notesHeight + 20;

  if (y + boxHeight > PAGE.height - FOOTER_RESERVE) {
    doc.addPage();
    y = MARGIN;
  }

  doc.roundedRect(MARGIN, y, CONTENT_WIDTH, boxHeight, 6).fill('#f9fafb');
  doc.fillColor(MUTED).font('Helvetica').fontSize(9);
  doc.text(message, MARGIN + 12, y + 10, { width: CONTENT_WIDTH - 24 });
  if (notes) {
    doc.fillColor(INK);
    doc.text(notes, MARGIN + 12, y + 14 + messageHeight, { width: CONTENT_WIDTH - 24 });
  }
  doc.fillColor(INK);

  return y + boxHeight + 12;
}

function paymentMessage(input: InvoicePdfInput): string {
  switch (input.status) {
    case 'paid':
      return `Paid in full on ${formatDate(input.paidAt ?? input.issuedAt)}. Thank you — no action is required.`;
    case 'void':
      return `This invoice was voided on ${formatDate(input.voidedAt)}${
        input.voidReason ? `: ${input.voidReason}` : '.'
      } It is not payable and has been retained only so the numbering stays unbroken.`;
    case 'uncollectible':
      return 'This invoice has been written off as uncollectible. Contact billing if you believe this is in error.';
    case 'draft':
      return 'Draft — this invoice has not been issued and carries no number yet.';
    default:
      return input.dueAt
        ? `${money(input.amountDueCents)} is due by ${formatDate(input.dueAt)}. Payment is collected automatically from the card on file unless arranged otherwise.`
        : `${money(input.amountDueCents)} is outstanding.`;
  }
}

/** Footer and page numbers, written after all content so the page count is
 *  known. `bufferPages` is what makes "Page 1 of 3" possible at all. */
function drawFooters(doc: Doc, input: InvoicePdfInput): void {
  const range = doc.bufferedPageRange();
  const footer = (input.footer ?? '').trim() || input.seller.legalName;

  for (let index = 0; index < range.count; index += 1) {
    doc.switchToPage(range.start + index);

    // pdfkit starts a new page when text crosses the bottom margin. Dropping
    // the margin for the footer write is the documented way to avoid an
    // endless cascade of blank pages.
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    const y = PAGE.height - 62;
    doc.moveTo(MARGIN, y).lineTo(RIGHT, y).lineWidth(0.5).strokeColor(LINE).stroke();

    doc.font('Helvetica').fontSize(8).fillColor(FAINT);
    doc.text(footer, MARGIN, y + 8, { width: CONTENT_WIDTH - 90 });
    doc.text(`Page ${index + 1} of ${range.count}`, RIGHT - 90, y + 8, {
      width: 90,
      align: 'right',
    });

    doc.page.margins.bottom = bottomMargin;
  }
}

function addressLines(party: SellerSnapshot | BillToSnapshot): string[] {
  // A party block prints only the fields that were actually captured — an
  // invoice with a blank line where the address should be looks like a bug.
  const lines: string[] = [];
  if (party.line1) lines.push(party.line1);
  if (party.line2) lines.push(party.line2);
  const locality = [party.city, party.region].filter(Boolean).join(', ');
  const localityLine = [locality, party.postalCode].filter(Boolean).join('  ');
  if (localityLine.trim()) lines.push(localityLine.trim());
  if (party.country) lines.push(party.country);
  return lines;
}
