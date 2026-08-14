/**
 * Turning a dataset into an HTTP download.
 *
 * Kept out of the route handlers so all three routes answer identically: same
 * format validation, same filename convention, same headers. A download that
 * opens correctly in Excel on one route and as a wall of text on another is
 * the usual outcome of writing these headers three times.
 */

import { z } from 'zod';
import type { RateLimitRule } from '../rate-limit';
import { datasetToCsv } from './csv';
import { renderDatasetPdf } from './pdf-report';
import type { ExportDataset } from './dataset';

/**
 * Shared limit for every export route.
 *
 * An export reads thousands of rows and can render a hundred-page PDF, so it
 * is far more expensive than the JSON endpoints beside it. Defined here rather
 * than in `LIMITS` because that map belongs to another module; the rule shape
 * is the same.
 */
export const EXPORT_RATE_LIMIT: RateLimitRule = { limit: 20, windowSeconds: 60 * 5 };

export const EXPORT_FORMATS = ['csv', 'pdf'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * Format validation.
 *
 * An explicit allow-list, not a cast: `?format=xlsx` and `?format=../../etc`
 * both have to fail loudly rather than fall through to a default and hand back
 * a file whose contents do not match its extension. `route()` renders the
 * ZodError as a 422 carrying this message.
 */
export function exportFormatSchema(defaultFormat: ExportFormat) {
  return z
    .enum(EXPORT_FORMATS, {
      errorMap: () => ({ message: `format must be one of: ${EXPORT_FORMATS.join(', ')}.` }),
    })
    .default(defaultFormat);
}

export const CONTENT_TYPES: Record<ExportFormat, string> = {
  // The charset matters: without it some clients assume latin-1 and undo the
  // work the BOM does inside the file.
  csv: 'text/csv; charset=utf-8',
  pdf: 'application/pdf',
};

/**
 * Reduce a filename to characters that survive every filesystem and, more
 * importantly, cannot break out of the Content-Disposition header. A quote or
 * a newline in this value is a header-injection bug; the builders produce safe
 * names, and this makes that a property of the code rather than a habit.
 */
export function sanitizeFilename(value: string): string {
  const cleaned = value
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned.slice(0, 120) || 'jobpilot-export';
}

export function exportFilename(dataset: ExportDataset, format: ExportFormat): string {
  return `${sanitizeFilename(dataset.filenameBase)}.${format}`;
}

/**
 * RFC 6266 disposition.
 *
 * Both forms are sent: the plain `filename` for old clients, and `filename*`
 * with percent-encoded UTF-8 for everything current. The plain one is already
 * ASCII-only after sanitising, so the two never disagree.
 */
export function contentDisposition(filename: string): string {
  return `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** Serialize a dataset and wrap it in a download response. */
export async function exportResponse(
  dataset: ExportDataset,
  format: ExportFormat,
): Promise<Response> {
  const filename = exportFilename(dataset, format);
  const body =
    format === 'pdf'
      ? await renderDatasetPdf(dataset)
      : Buffer.from(datasetToCsv(dataset), 'utf8');

  return new Response(
    // Copy into a plain Uint8Array: `Response` wants a BodyInit, and a Buffer
    // backed by Node's shared pool can otherwise expose neighbouring bytes.
    new Uint8Array(body),
    {
      headers: {
        'Content-Type': CONTENT_TYPES[format],
        'Content-Length': String(body.byteLength),
        'Content-Disposition': contentDisposition(filename),
        // Exports contain personal data; they must not be cached by a shared
        // proxy or written to disk by the browser's HTTP cache.
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  );
}
