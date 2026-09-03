import { RESUME_SECTION_ORDER, textsOf, type DocumentModel } from './model';

/**
 * Stage 09 — ATS structure validation.
 *
 * What a résumé parser needs from a file is boringly specific: a contact
 * block it can find, headings it recognises in the order it expects, dates
 * it can read, one column, and text it can actually extract. These checks
 * assert exactly that on the MODEL, and — when the renderer's output can be
 * read back (`extractPdfText`, `extractDocxText`) — that every line the
 * model carries survived rendering. The report is stored on the
 * `DocumentVersion` so a later reader sees what was checked, not a
 * "ATS-optimised" badge.
 */
export interface AtsCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface AtsReport {
  ok: boolean;
  checks: AtsCheck[];
  version: string;
}

export const ATS_CHECK_VERSION = '2026-09-03.1';

const EMAIL = /[^\s@|]+@[^\s@|]+\.[^\s@|]+/;
/** "2021-01 – Present", "2018 – 2020", "Jan 2021 – Mar 2023". */
const DATE_RANGE = /^(\d{4}(-\d{2})?|[A-Z][a-z]{2,8} \d{4}) – (\d{4}(-\d{2})?|[A-Z][a-z]{2,8} \d{4}|present|current)$/i;

const squash = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

export function atsReport(model: DocumentModel, extractedText?: string): AtsReport {
  const checks: AtsCheck[] = [];
  const order = RESUME_SECTION_ORDER as readonly string[];
  const isResume = model.sections.some((s) => order.includes(s.heading));

  if (isResume) {
    checks.push({ name: 'contact_block', ok: model.header.some((h) => EMAIL.test(h)), detail: 'an email address in the header' });
    const headings = model.sections.map((s) => s.heading);
    const known = headings.filter((h) => order.includes(h));
    checks.push({
      name: 'standard_headings',
      ok: known.length === headings.length && headings.every((h) => h === h.toUpperCase()),
      detail: headings.join(', '),
    });
    const positions = known.map((h) => order.indexOf(h));
    checks.push({ name: 'heading_order', ok: positions.every((v, i) => i === 0 || v > positions[i - 1]) });
    const roles = model.sections.filter((s) => s.heading === 'PROFESSIONAL EXPERIENCE').flatMap((s) => s.entries ?? []);
    const badDates = roles.filter((e) => !e.sub || !DATE_RANGE.test(e.sub)).map((e) => e.sub ?? '(none)');
    checks.push({ name: 'date_format', ok: badDates.length === 0, detail: badDates.length ? badDates.join('; ') : 'YYYY-MM – YYYY-MM | Present' });
  }

  const all = textsOf(model);
  checks.push({ name: 'single_column_plain_text', ok: all.every((t) => !/\t/.test(t)), detail: 'no tab-separated columns, no tables, no graphics' });

  if (extractedText !== undefined) {
    const hay = squash(extractedText);
    const missing = all.filter((t) => t.trim() && !hay.includes(squash(t)));
    checks.push({
      name: 'parse_back',
      ok: missing.length === 0,
      detail: missing.length ? `not recoverable from the rendered file: ${missing.slice(0, 3).join(' | ')}` : 'every line recovered from the rendered file',
    });
  }

  return { ok: checks.every((c) => c.ok), checks, version: ATS_CHECK_VERSION };
}
