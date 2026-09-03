// pdfkit's default entry reads its standard-font metrics with `fs` at
// runtime and dies with ENOENT inside a Next bundle; the standalone build
// inlines them. Same import, same reason, as src/lib/billing/invoice-pdf.ts.
// @ts-expect-error — the standalone bundle ships no declarations of its own;
// @types/pdfkit describes the identical API and is applied on the next line.
import PDFDocumentStandalone from 'pdfkit/js/pdfkit.standalone.js';
import type { DocumentModel } from './model';

const PDFDocument = PDFDocumentStandalone as unknown as typeof import('pdfkit');

/**
 * Stage 09 — the PDF renderer.
 *
 * Deterministic by construction: standard (non-embedded) Helvetica, no
 * compression (so the text is readable back for the parse-back check and
 * the bytes carry no zlib variance), fixed page geometry, and the creation
 * and modification dates supplied by the caller rather than "now". The same
 * model with the same `createdAt` renders the same bytes (tested), which is
 * what makes a stored content hash meaningful.
 */
export interface RenderOptions {
  author: string;
  createdAt: Date;
}

const MARGIN = 54;

export function renderPdf(model: DocumentModel, opts: RenderOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
      compress: false,
      pdfVersion: '1.4',
      info: { Title: model.title, Author: opts.author, Creator: 'JobPilot', Producer: 'JobPilot', CreationDate: opts.createdAt, ModDate: opts.createdAt },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const width = doc.page.width - MARGIN * 2;
    const body = () => doc.font('Helvetica').fontSize(10).fillColor('#000000');

    model.header.forEach((line, i) => {
      if (i === 0) doc.font('Helvetica-Bold').fontSize(16).fillColor('#000000').text(line, { width });
      else body().text(line, { width });
    });

    for (const section of model.sections) {
      if (section.heading) {
        doc.moveDown(0.8);
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#000000').text(section.heading, { width });
        doc.moveDown(0.3);
      }
      for (const p of section.paragraphs ?? []) {
        body().text(p, { width });
        doc.moveDown(0.5);
      }
      for (const b of section.bullets ?? []) body().text(`• ${b}`, { width });
      for (const e of section.entries ?? []) {
        doc.moveDown(0.4);
        doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000').text(e.heading, { width });
        if (e.sub) doc.font('Helvetica').fontSize(9).fillColor('#555555').text(e.sub, { width });
        for (const b of e.bullets) body().text(`• ${b}`, { width });
      }
    }
    doc.end();
  });
}

/** The WinAnsi (cp1252) code points that differ from Latin-1, which is what pdfkit's standard fonts write. */
const CP1252: Record<number, string> = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž',
  0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};

function decodeHex(hex: string): string {
  let out = '';
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const code = parseInt(hex.slice(i, i + 2), 16);
    out += CP1252[code] ?? String.fromCharCode(code);
  }
  return out;
}

/**
 * Read the text back out of a PDF this renderer produced: uncompressed
 * content streams, one `BT … ET` block per rendered line, text as WinAnsi
 * hex strings in `Tj` / `TJ` operators. This is a parse-back for OUR files,
 * not a general PDF text extractor, and it is used for nothing else.
 */
export function extractPdfText(pdf: Buffer): string {
  const src = pdf.toString('latin1');
  const lines: string[] = [];
  for (const block of src.matchAll(/BT([\s\S]*?)ET/g)) {
    const parts: string[] = [];
    for (const op of block[1].matchAll(/\[((?:<[0-9a-fA-F]*>|\s|-?\d+(?:\.\d+)?)*)\]\s*TJ|<([0-9a-fA-F]*)>\s*Tj|\(((?:\\.|[^\\)])*)\)\s*Tj/g)) {
      if (op[1] !== undefined) for (const h of op[1].matchAll(/<([0-9a-fA-F]*)>/g)) parts.push(decodeHex(h[1]));
      else if (op[2] !== undefined) parts.push(decodeHex(op[2]));
      else if (op[3] !== undefined) parts.push(op[3].replace(/\\([()\\])/g, '$1'));
    }
    if (parts.length) lines.push(parts.join(''));
  }
  return lines.join('\n');
}
