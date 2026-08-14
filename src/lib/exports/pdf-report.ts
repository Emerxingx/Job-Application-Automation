// pdfkit's default entry reads its standard-font metrics at runtime with
// `fs.readFileSync(__dirname + '/data/Helvetica.afm')`. Next bundles route
// handlers, `__dirname` then resolves inside `.next/server/...` where those
// .afm files are not, and every render dies on ENOENT. The standalone build is
// the same library with the metrics inlined and no `fs` access, so it survives
// bundling. src/lib/billing/invoice-pdf.ts imports it the same way and for the
// same reason.
// @ts-expect-error — the standalone bundle ships no declarations of its own;
// @types/pdfkit describes the identical API and is applied on the next line.
import PDFDocumentStandalone from 'pdfkit/js/pdfkit.standalone.js';
import {
  alignmentOf,
  displayCell,
  formatDateTimeDisplay,
  printableColumns,
  type CellKind,
  type ExportColumn,
  type ExportDataset,
  type ExportFilter,
  type ExportRow,
  type ExportStat,
} from './dataset';

const PDFDocument = PDFDocumentStandalone as unknown as typeof import('pdfkit');

/**
 * A generic tabular report renderer.
 *
 * It knows nothing about applications, invoices or analytics — it takes a
 * title, some filters, some stats and one or more tables, and lays them out.
 * Every dataset in this module renders through it, so a fix to pagination or
 * column fitting fixes every report at once.
 *
 * The layout is absolute-positioned rather than flowed. pdfkit's flow layout
 * cannot express "this cell is three columns wide and right-aligned, and the
 * row is as tall as the tallest cell in it", and a table that overlaps itself
 * on row 40 of page 3 is worse than no PDF at all.
 */

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface ReportTable {
  /** Optional heading above the table. Omitted for a report's main table. */
  title?: string;
  columns: ExportColumn[];
  rows: ExportRow[];
  emptyMessage?: string;
}

export interface ReportInput {
  title: string;
  subtitle?: string;
  generatedAt: Date;
  /** Printed under the title so a saved PDF still says what it was filtered to. */
  filters?: ExportFilter[];
  /** Headline figures, printed as cards above the first table. */
  summary?: ExportStat[];
  tables: ReportTable[];
  /** Printed after the last table — used for the row-cap warning. */
  note?: string;
  /** Left-hand footer text on every page. */
  footer?: string;
}

/**
 * Turn a dataset into report input.
 *
 * CSV-only columns are dropped here: a spreadsheet can carry twenty columns,
 * a portrait page cannot, and squeezing all of them in makes every one of them
 * illegible. The PDF keeps the columns a person reads; the CSV keeps
 * everything.
 */
export function reportInputFrom(dataset: ExportDataset): ReportInput {
  return {
    title: dataset.title,
    subtitle: dataset.subtitle,
    generatedAt: dataset.generatedAt,
    filters: dataset.filters,
    summary: dataset.summary,
    tables: [
      {
        columns: printableColumns(dataset.columns),
        rows: dataset.rows,
        emptyMessage: dataset.emptyMessage,
      },
      ...dataset.sections.map((section) => ({
        title: section.title,
        columns: printableColumns(section.columns),
        rows: section.rows,
        emptyMessage: section.emptyMessage,
      })),
    ],
    note: dataset.note,
    footer: 'JobPilot AI · jobpilot.ai',
  };
}

// ---------------------------------------------------------------------------
// Geometry and palette
// ---------------------------------------------------------------------------

const PAGE = { width: 612, height: 792 }; // US Letter portrait, in points
const MARGIN = 48;
const RIGHT = PAGE.width - MARGIN; // 564
const CONTENT_WIDTH = RIGHT - MARGIN; // 516

/** Space kept clear at the bottom of every page for the footer rule. */
const FOOTER_RESERVE = 44;
const BOTTOM_LIMIT = PAGE.height - MARGIN - FOOTER_RESERVE;

const HEADER_ROW_HEIGHT = 20;
const MIN_ROW_HEIGHT = 20;
const CELL_PAD_X = 6;
const CELL_PAD_Y = 6;
const BODY_FONT_SIZE = 9;
/** A single cell never grows past this many lines; longer text is elided. */
const MAX_CELL_LINES = 3;
const MIN_COLUMN_WIDTH = 38;

const INK = '#111827';
const MUTED = '#4b5563';
const FAINT = '#9ca3af';
const LINE = '#e5e7eb';
const ZEBRA = '#fafafa';
const PANEL = '#f9fafb';
const BRAND = '#4f46e5';

type Doc = InstanceType<typeof PDFDocument>;

// ---------------------------------------------------------------------------
// Column fitting (pure — tested directly)
// ---------------------------------------------------------------------------

/** How much room a kind of value usually needs, relative to the others. */
function defaultWeight(kind: CellKind | undefined): number {
  switch (kind) {
    case 'datetime':
      return 1.6;
    case 'date':
      return 1.2;
    case 'money':
      return 1.1;
    case 'number':
    case 'percent':
      return 0.9;
    case 'boolean':
      return 0.7;
    default:
      return 2;
  }
}

/**
 * Distribute `available` points across columns.
 *
 * `column.width` is a weight, not a measurement, so a builder can say "the
 * description column is three times the status column" without knowing the
 * page size. Columns that come out narrower than `minWidth` are lifted to it
 * and the difference is taken proportionally from the columns with slack —
 * otherwise a nine-column table renders a "Score" heading as "Sc…".
 *
 * The returned widths always sum to exactly `available`, so the last column's
 * right edge lands on the margin instead of one rounding error short of it.
 */
export function resolveColumnWidths(
  columns: readonly ExportColumn[],
  available: number,
  minWidth: number = MIN_COLUMN_WIDTH,
): number[] {
  if (columns.length === 0) return [];

  const weights = columns.map((column) => Math.max(0.01, column.width ?? defaultWeight(column.kind)));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let widths = weights.map((weight) => (weight / totalWeight) * available);

  // With many columns the floor itself may not fit; an even split is then the
  // best possible outcome and the loop below becomes a no-op.
  const floor = Math.min(minWidth, available / columns.length);
  const deficit = widths.reduce((sum, width) => sum + Math.max(0, floor - width), 0);
  if (deficit > 0) {
    const slack = widths.reduce((sum, width) => sum + Math.max(0, width - floor), 0);
    widths = widths.map((width) =>
      width <= floor ? floor : width - (deficit * (width - floor)) / slack,
    );
  }

  const drift = available - widths.reduce((sum, width) => sum + width, 0);
  widths[widths.length - 1] += drift;
  return widths;
}

/** Left edge of each column, given its width. */
function columnOffsets(widths: readonly number[], startX: number): number[] {
  const offsets: number[] = [];
  let x = startX;
  for (const width of widths) {
    offsets.push(x);
    x += width;
  }
  return offsets;
}

// ---------------------------------------------------------------------------
// Text fitting
// ---------------------------------------------------------------------------

/**
 * Shorten text until it wraps into at most `maxLines`, appending an ellipsis.
 *
 * Row height is driven by the tallest cell, so one 900-character note would
 * otherwise produce a row taller than the page — which pdfkit "handles" by
 * flowing onto the next page mid-row, overlapping the header we just drew.
 * The binary search runs only for cells that actually overflow, so the common
 * case costs one `heightOfString`.
 */
export function fitCellText(doc: Doc, text: string, width: number, maxLines: number): string {
  if (!text) return '';
  const limit = maxLines * doc.currentLineHeight() + 0.5;
  if (doc.heightOfString(text, { width }) <= limit) return text;

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = `${text.slice(0, mid).trimEnd()}…`;
    if (doc.heightOfString(candidate, { width }) <= limit) low = mid;
    else high = mid - 1;
  }
  return `${text.slice(0, low).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Render the report and resolve with the finished PDF bytes. */
export function renderReportPdf(input: ReportInput): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: [PAGE.width, PAGE.height],
        margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
        // Required for "Page 1 of 4": the total is only known once every page
        // exists, so the footers are written in a second pass at the end.
        bufferPages: true,
        info: {
          Title: input.title,
          Author: 'JobPilot AI',
          Subject: input.subtitle ?? input.title,
          Creator: 'JobPilot AI',
        },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('error', reject);
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      drawReport(doc, input);
      doc.end();
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function drawReport(doc: Doc, input: ReportInput): void {
  let y = drawHeader(doc, input);
  y = drawSummary(doc, input.summary ?? [], y);

  for (const table of input.tables) {
    y = drawTable(doc, table, y);
  }

  if (input.note) {
    y = ensureRoom(doc, y, 26);
    doc.font('Helvetica-Oblique').fontSize(8).fillColor(MUTED);
    doc.text(input.note, MARGIN, y, { width: CONTENT_WIDTH });
    doc.fillColor(INK);
  }

  drawFooters(doc, input);
}

function drawHeader(doc: Doc, input: ReportInput): number {
  doc.font('Helvetica-Bold').fontSize(18).fillColor(INK);
  doc.text(input.title, MARGIN, MARGIN, { width: CONTENT_WIDTH - 150 });

  // The generated-at stamp sits opposite the title: an exported report gets
  // emailed around, and "as of when" is the first thing anyone asks.
  doc.font('Helvetica').fontSize(8).fillColor(FAINT);
  doc.text('GENERATED', RIGHT - 150, MARGIN + 2, { width: 150, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED);
  doc.text(formatDateTimeDisplay(input.generatedAt), RIGHT - 150, MARGIN + 13, {
    width: 150,
    align: 'right',
  });

  let y = MARGIN + 26;

  if (input.subtitle) {
    doc.font('Helvetica').fontSize(10).fillColor(MUTED);
    doc.text(input.subtitle, MARGIN, y, { width: CONTENT_WIDTH - 150 });
    y += doc.heightOfString(input.subtitle, { width: CONTENT_WIDTH - 150 }) + 2;
  }

  const filters = input.filters ?? [];
  if (filters.length > 0) {
    const text = filters.map((filter) => `${filter.label}: ${filter.value}`).join('   ·   ');
    doc.font('Helvetica').fontSize(8.5).fillColor(FAINT);
    doc.text(text, MARGIN, y + 2, { width: CONTENT_WIDTH });
    y += doc.heightOfString(text, { width: CONTENT_WIDTH }) + 4;
  }

  y += 8;
  doc.moveTo(MARGIN, y).lineTo(RIGHT, y).lineWidth(1).strokeColor(BRAND).stroke();
  doc.fillColor(INK);
  return y + 16;
}

/** Stat cards, three to a row. */
function drawSummary(doc: Doc, stats: readonly ExportStat[], top: number): number {
  if (stats.length === 0) return top;

  const perRow = 3;
  const gutter = 10;
  const cardWidth = (CONTENT_WIDTH - gutter * (perRow - 1)) / perRow;
  const cardHeight = 42;
  let y = top;

  for (let index = 0; index < stats.length; index += 1) {
    const column = index % perRow;
    if (column === 0) y = ensureRoom(doc, y, cardHeight + 8);
    const x = MARGIN + column * (cardWidth + gutter);

    doc.roundedRect(x, y, cardWidth, cardHeight, 4).fill(PANEL);
    doc.font('Helvetica').fontSize(7.5).fillColor(FAINT);
    doc.text(stats[index].label.toUpperCase(), x + 10, y + 8, {
      width: cardWidth - 20,
      lineBreak: false,
      ellipsis: true,
    });
    doc.font('Helvetica-Bold').fontSize(13).fillColor(INK);
    doc.text(stats[index].value, x + 10, y + 20, {
      width: cardWidth - 20,
      lineBreak: false,
      ellipsis: true,
    });

    if (column === perRow - 1 || index === stats.length - 1) y += cardHeight + gutter;
  }

  doc.fillColor(INK);
  return y + 6;
}

/** Move to a new page when `needed` points do not remain. */
function ensureRoom(doc: Doc, y: number, needed: number): number {
  if (y + needed <= BOTTOM_LIMIT) return y;
  doc.addPage();
  return MARGIN;
}

function drawTableHeader(doc: Doc, columns: readonly ExportColumn[], widths: readonly number[], y: number): number {
  const offsets = columnOffsets(widths, MARGIN);

  doc.rect(MARGIN, y, CONTENT_WIDTH, HEADER_ROW_HEIGHT).fill(PANEL);
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED);

  columns.forEach((column, index) => {
    doc.text(column.header.toUpperCase(), offsets[index] + CELL_PAD_X, y + 7, {
      width: Math.max(1, widths[index] - CELL_PAD_X * 2),
      align: alignmentOf(column),
      lineBreak: false,
      ellipsis: true,
    });
  });

  const bottom = y + HEADER_ROW_HEIGHT;
  doc.moveTo(MARGIN, bottom).lineTo(RIGHT, bottom).lineWidth(0.75).strokeColor(LINE).stroke();
  doc.fillColor(INK);
  return bottom;
}

function drawTable(doc: Doc, table: ReportTable, top: number): number {
  const widths = resolveColumnWidths(table.columns, CONTENT_WIDTH);
  const offsets = columnOffsets(widths, MARGIN);
  let y = top;

  if (table.title) {
    // Keep the title with its header row and at least one body row, so a
    // section heading never sits alone at the foot of a page.
    y = ensureRoom(doc, y, 18 + HEADER_ROW_HEIGHT + MIN_ROW_HEIGHT);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK);
    doc.text(table.title, MARGIN, y, { width: CONTENT_WIDTH });
    y += 18;
  }

  if (table.rows.length === 0) {
    y = ensureRoom(doc, y, 40);
    doc.roundedRect(MARGIN, y, CONTENT_WIDTH, 32, 4).fill(PANEL);
    doc.font('Helvetica').fontSize(9).fillColor(MUTED);
    doc.text(table.emptyMessage ?? 'Nothing to report for this range.', MARGIN + 12, y + 11, {
      width: CONTENT_WIDTH - 24,
      lineBreak: false,
      ellipsis: true,
    });
    doc.fillColor(INK);
    return y + 44;
  }

  y = ensureRoom(doc, y, HEADER_ROW_HEIGHT + MIN_ROW_HEIGHT);
  y = drawTableHeader(doc, table.columns, widths, y);

  table.rows.forEach((row, rowIndex) => {
    doc.font('Helvetica').fontSize(BODY_FONT_SIZE);
    const lineHeight = doc.currentLineHeight();

    // Measure first, draw second: the row is as tall as its tallest cell, and
    // that has to be known before deciding whether it fits on this page.
    const cells = table.columns.map((column, index) => {
      const raw = displayCell(row[column.key], column.kind);
      const width = Math.max(1, widths[index] - CELL_PAD_X * 2);
      const text = fitCellText(doc, raw, width, MAX_CELL_LINES);
      return { text, width, height: doc.heightOfString(text, { width }) };
    });

    const rowHeight = Math.max(
      MIN_ROW_HEIGHT,
      Math.ceil(Math.max(lineHeight, ...cells.map((cell) => cell.height)) + CELL_PAD_Y * 2),
    );

    if (y + rowHeight > BOTTOM_LIMIT) {
      doc.addPage();
      y = MARGIN;
      // Repeat the header on the new page — a table whose columns are only
      // labelled on page 1 is unreadable by page 4.
      y = drawTableHeader(doc, table.columns, widths, y);
    }

    if (rowIndex % 2 === 1) {
      doc.rect(MARGIN, y, CONTENT_WIDTH, rowHeight).fill(ZEBRA);
    }

    doc.font('Helvetica').fontSize(BODY_FONT_SIZE).fillColor(INK);
    cells.forEach((cell, index) => {
      doc.text(cell.text, offsets[index] + CELL_PAD_X, y + CELL_PAD_Y, {
        width: cell.width,
        align: alignmentOf(table.columns[index]),
      });
    });

    y += rowHeight;
    doc.moveTo(MARGIN, y).lineTo(RIGHT, y).lineWidth(0.4).strokeColor(LINE).stroke();
  });

  doc.fillColor(INK);
  return y + 18;
}

/**
 * Footer and page numbers, written once every page exists.
 *
 * `bufferPages: true` is what makes the total knowable. Dropping the bottom
 * margin around the write is the documented way to stop pdfkit from treating
 * footer text as content that overflows onto a fresh page — which would add a
 * page, whose footer would add another.
 */
function drawFooters(doc: Doc, input: ReportInput): void {
  const range = doc.bufferedPageRange();
  const footer = input.footer ?? 'JobPilot AI';

  for (let index = 0; index < range.count; index += 1) {
    doc.switchToPage(range.start + index);

    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    const y = PAGE.height - MARGIN - 18;
    doc.moveTo(MARGIN, y).lineTo(RIGHT, y).lineWidth(0.5).strokeColor(LINE).stroke();

    doc.font('Helvetica').fontSize(7.5).fillColor(FAINT);
    doc.text(footer, MARGIN, y + 6, { width: CONTENT_WIDTH - 110, lineBreak: false, ellipsis: true });
    doc.text(`Page ${index + 1} of ${range.count}`, RIGHT - 110, y + 6, {
      width: 110,
      align: 'right',
      lineBreak: false,
    });

    doc.page.margins.bottom = bottomMargin;
  }
}

/** Render a dataset straight to PDF bytes. */
export function renderDatasetPdf(dataset: ExportDataset): Promise<Buffer> {
  return renderReportPdf(reportInputFrom(dataset));
}
