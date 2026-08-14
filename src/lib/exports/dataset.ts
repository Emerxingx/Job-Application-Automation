/**
 * The shape every export shares.
 *
 * A builder produces one `ExportDataset` and both renderers consume it: the
 * CSV serializer writes machine-readable cells (ISO dates, unformatted
 * decimals) and the PDF renderer writes human-readable ones ("Aug 14, 2026",
 * "$1,234.56"). Keeping one dataset rather than two row-shaping passes is what
 * guarantees the CSV and the PDF of the same report can never disagree about
 * which rows exist.
 *
 * Cells hold *values*, never pre-formatted strings — a money cell is integer
 * cents, a date cell is a `Date`. Formatting is a rendering decision, and the
 * two renderers make it differently on purpose.
 */

/** Everything a cell may hold. Rows come from Prisma, so `null` is common. */
export type CellValue = string | number | boolean | Date | null | undefined;

/**
 * How a value should be read.
 *
 * - `money`   integer cents (the database convention), never a float
 * - `percent` a number already in percent units: 42.5 means 42.5%
 * - `date`    calendar day; rendered UTC so an export is stable wherever the
 *             server runs
 * - `datetime` an instant; ISO-8601 in CSV so spreadsheets and scripts agree
 */
export type CellKind = 'text' | 'number' | 'money' | 'date' | 'datetime' | 'boolean' | 'percent';

export interface ExportColumn {
  /** Key into the row record. */
  key: string;
  /** Column heading, shown in both outputs. */
  header: string;
  kind?: CellKind;
  /**
   * Relative width for the PDF table. Widths are weights, not points: the
   * renderer normalises them across the printable width so a builder never has
   * to know the page geometry. Ignored by CSV.
   */
  width?: number;
  align?: 'left' | 'right';
  /**
   * Carried in CSV, dropped from the PDF. A spreadsheet can hold twenty
   * columns; a portrait page cannot, and shrinking every column to fit makes
   * the page unreadable. Detail columns (URLs, notes, keyword lists) are
   * marked this way so the PDF keeps the columns a person actually reads.
   */
  csvOnly?: boolean;
}

export type ExportRow = Record<string, CellValue>;

/** An extra table below the main one — analytics breakdowns use these. */
export interface ExportSection {
  title: string;
  columns: ExportColumn[];
  rows: ExportRow[];
  emptyMessage?: string;
}

export interface ExportFilter {
  label: string;
  value: string;
}

export interface ExportStat {
  label: string;
  value: string;
}

export interface ExportDataset {
  title: string;
  subtitle?: string;
  /**
   * Filename without extension or directory. Builders always include the date
   * range here so a folder of downloads stays self-describing.
   */
  filenameBase: string;
  generatedAt: Date;
  /** What the reader filtered by; printed under the title in the PDF. */
  filters: ExportFilter[];
  /** Headline numbers, printed above the table in the PDF. */
  summary: ExportStat[];
  columns: ExportColumn[];
  rows: ExportRow[];
  sections: ExportSection[];
  emptyMessage: string;
  /** Set when the row cap truncated the result, so both renderers can say so. */
  note?: string;
}

// ---------------------------------------------------------------------------
// Value formatting
// ---------------------------------------------------------------------------

/** Accept a Date, an ISO string or an epoch number; reject anything unusable. */
export function toDate(value: CellValue): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const fromEpoch = new Date(value);
    return Number.isNaN(fromEpoch.getTime()) ? null : fromEpoch;
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/**
 * Money for machines: "1234.56", no symbol, no thousands separator.
 *
 * Both omissions are deliberate. "$1,234.56" is text to Excel and to
 * `parseFloat`; "1234.56" is a number to both. The arithmetic is integer —
 * dividing cents by 100 in floating point is how a total ends up at 1234.5600000000001.
 */
export function formatCentsPlain(cents: number): string {
  if (!Number.isFinite(cents)) return '';
  const whole = Math.trunc(cents);
  const sign = whole < 0 ? '-' : '';
  const absolute = Math.abs(whole);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

/** Money for people: "$1,234.56". Grouped, signed, always two decimals. */
export function formatCentsDisplay(cents: number): string {
  if (!Number.isFinite(cents)) return '—';
  const whole = Math.trunc(cents);
  const sign = whole < 0 ? '-' : '';
  const absolute = Math.abs(whole);
  const dollars = Math.floor(absolute / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${dollars}.${String(absolute % 100).padStart(2, '0')}`;
}

/** `YYYY-MM-DD` in UTC — sorts lexicographically and never shifts by timezone. */
export function formatDateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** "Aug 14, 2026". Fixed to UTC so the PDF matches the CSV row beside it. */
export function formatDateDisplay(value: Date): string {
  return value.toLocaleDateString('en-CA', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** "Aug 14, 2026, 05:12 UTC". */
export function formatDateTimeDisplay(value: Date): string {
  const time = value.toLocaleTimeString('en-CA', {
    timeZone: 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${formatDateDisplay(value)}, ${time} UTC`;
}

/** Title-case a snake_case status: `ready_to_submit` -> `Ready to submit`. */
export function humanizeToken(value: string): string {
  const spaced = value.replace(/[_-]+/g, ' ').trim();
  if (!spaced) return '';
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The machine-readable rendering of a cell — what goes into CSV.
 *
 * Note what this does *not* do: it never quotes, never escapes and never
 * guards against formula injection. That is the serializer's job, and keeping
 * it there means a cell cannot be escaped twice.
 */
export function csvCell(value: CellValue, kind: CellKind = 'text'): string {
  if (value === null || value === undefined) return '';

  switch (kind) {
    case 'money':
      return typeof value === 'number' ? formatCentsPlain(value) : String(value);
    case 'number':
      if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
      return String(value);
    case 'percent':
      if (typeof value === 'number') return Number.isFinite(value) ? value.toFixed(1) : '';
      return String(value);
    case 'boolean':
      // `true` / `false` rather than Yes / No: the CSV is also read by scripts.
      return typeof value === 'boolean' ? String(value) : String(value);
    case 'date': {
      const date = toDate(value);
      return date ? formatDateKey(date) : '';
    }
    case 'datetime': {
      const date = toDate(value);
      return date ? date.toISOString() : '';
    }
    default:
      return value instanceof Date ? value.toISOString() : String(value);
  }
}

/** The human-readable rendering of a cell — what goes into the PDF. */
export function displayCell(value: CellValue, kind: CellKind = 'text'): string {
  if (value === null || value === undefined || value === '') return '—';

  switch (kind) {
    case 'money':
      return typeof value === 'number' ? formatCentsDisplay(value) : String(value);
    case 'number':
      if (typeof value === 'number') {
        return Number.isFinite(value) ? value.toLocaleString('en-CA') : '—';
      }
      return String(value);
    case 'percent':
      if (typeof value === 'number') return Number.isFinite(value) ? `${value.toFixed(1)}%` : '—';
      return String(value);
    case 'boolean':
      return value ? 'Yes' : 'No';
    case 'date': {
      const date = toDate(value);
      return date ? formatDateDisplay(date) : '—';
    }
    case 'datetime': {
      const date = toDate(value);
      return date ? formatDateTimeDisplay(date) : '—';
    }
    default:
      return value instanceof Date ? formatDateDisplay(value) : String(value);
  }
}

/** Columns a printed page should carry: everything not marked CSV-only. */
export function printableColumns(columns: ExportColumn[]): ExportColumn[] {
  return columns.filter((column) => !column.csvOnly);
}

/** Default alignment by kind — numbers right, words left. */
export function alignmentOf(column: ExportColumn): 'left' | 'right' {
  if (column.align) return column.align;
  const kind = column.kind ?? 'text';
  return kind === 'money' || kind === 'number' || kind === 'percent' ? 'right' : 'left';
}
