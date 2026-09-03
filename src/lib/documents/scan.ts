import JSZip from 'jszip';

/**
 * Stage 09 — server-side scanning of an uploaded document BEFORE it is
 * stored or parsed.
 *
 * What is checked, and why each check is here:
 *   - the type is sniffed from the bytes, never trusted from the name or the
 *     declared MIME type, and must agree with the extension;
 *   - size caps on the file and, for a zip container, on the entry count and
 *     the declared uncompressed size (a small .docx that inflates to
 *     gigabytes is a decompression bomb);
 *   - a PDF carrying active content (JavaScript, open/launch actions, embedded
 *     files, rich media, XFA forms) is refused outright — a résumé needs none;
 *   - a DOCX carrying VBA macros, a macro-enabled content type, or external
 *     OLE/template references is refused for the same reason;
 *   - plain text must be valid UTF-8 without NUL bytes.
 *
 * What is NOT here: antivirus signature scanning. No engine (ClamAV or a
 * managed scanner) is available in this environment; the register records
 * it as NOT AVAILABLE and nothing pretends otherwise.
 */
export type UploadFormat = 'pdf' | 'docx' | 'txt';

export interface ScanResult {
  ok: boolean;
  format: UploadFormat | null;
  sizeBytes: number;
  /** Stable reason codes, never the file's content. */
  reasons: string[];
}

export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
const ZIP_MAX_ENTRIES = 200;
const ZIP_MAX_UNCOMPRESSED = 50 * 1024 * 1024;

const PDF_ACTIVE_CONTENT = [/\/JavaScript\b/, /\/JS\b/, /\/OpenAction\b/, /\/AA\b/, /\/Launch\b/, /\/EmbeddedFile\b/, /\/RichMedia\b/, /\/XFA\b/];
const EXTENSIONS: Record<UploadFormat, string[]> = { pdf: ['pdf'], docx: ['docx'], txt: ['txt', 'md'] };

export async function scanUpload(bytes: Buffer, fileName: string): Promise<ScanResult> {
  const reasons: string[] = [];
  const ext = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  if (bytes.length === 0) return { ok: false, format: null, sizeBytes: 0, reasons: ['empty'] };
  if (bytes.length > UPLOAD_MAX_BYTES) return { ok: false, format: null, sizeBytes: bytes.length, reasons: ['too_large'] };

  let format: UploadFormat | null = null;
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') {
    format = 'pdf';
    const text = bytes.toString('latin1');
    if (PDF_ACTIVE_CONTENT.some((p) => p.test(text))) reasons.push('pdf_active_content');
  } else if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(bytes);
    } catch {
      return { ok: false, format: null, sizeBytes: bytes.length, reasons: ['zip_unreadable'] };
    }
    const names = Object.keys(zip.files);
    if (!names.includes('[Content_Types].xml') || !names.includes('word/document.xml')) {
      return { ok: false, format: null, sizeBytes: bytes.length, reasons: ['not_docx'] };
    }
    format = 'docx';
    if (names.length > ZIP_MAX_ENTRIES) reasons.push('zip_too_many_entries');
    if (names.some((n) => n.split('/').includes('..') || n.startsWith('/'))) reasons.push('zip_path_traversal');
    let declared = 0;
    for (const n of names) {
      const entry = zip.files[n] as unknown as { dir: boolean; _data?: { uncompressedSize?: number } };
      if (!entry.dir) declared += entry._data?.uncompressedSize ?? 0;
    }
    if (declared > ZIP_MAX_UNCOMPRESSED) reasons.push('zip_bomb');
    if (names.some((n) => /(^|\/)vbaProject\.bin$|(^|\/)vbaData\.xml$/i.test(n))) reasons.push('docx_macros');
    const contentTypes = await zip.file('[Content_Types].xml')!.async('string');
    if (/macroEnabled/i.test(contentTypes)) reasons.push('docx_macros');
    for (const relName of names.filter((n) => n.endsWith('.rels'))) {
      const rels = await zip.file(relName)!.async('string');
      if (/TargetMode="External"/.test(rels) && /oleObject|attachedTemplate|frame/i.test(rels)) {
        reasons.push('docx_external_reference');
        break;
      }
    }
  } else if (isPlainText(bytes)) {
    format = 'txt';
  } else {
    return { ok: false, format: null, sizeBytes: bytes.length, reasons: ['unrecognised_type'] };
  }

  if (!EXTENSIONS[format].includes(ext)) reasons.push('extension_mismatch');
  const unique = [...new Set(reasons)];
  return { ok: unique.length === 0, format, sizeBytes: bytes.length, reasons: unique };
}

function isPlainText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}
