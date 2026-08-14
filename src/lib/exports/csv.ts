/**
 * CSV serialization.
 *
 * CSV looks like `values.join(',')` and is not. Everything below exists
 * because a naive join corrupts real job-application data:
 *
 *  1. **Delimiters inside values.** "Toronto, ON" splits one column into two
 *     and shifts every column after it. RFC 4180: wrap the field in double
 *     quotes.
 *  2. **Quotes inside values.** A job titled `Senior "Full Stack" Dev` ends the
 *     quoted field early. RFC 4180: double each embedded quote (`""`).
 *  3. **Newlines inside values.** Application notes are multi-line, and a raw
 *     newline ends the *record*, not just the field. Quoted fields may contain
 *     CR and LF, so quoting fixes this too — but only if you remember to check
 *     for them.
 *  4. **Formula injection.** Excel, LibreOffice and Google Sheets evaluate any
 *     cell whose text starts with `=`, `+`, `-`, `@`, tab or CR. A company name
 *     of `=cmd|'/C calc'!A0` is a remote-code-execution vector against whoever
 *     opens the export, and none of the escaping above stops it, because the
 *     file is perfectly valid CSV. The fix is a leading apostrophe, which
 *     spreadsheets consume as "treat as text". See `looksLikeFormula`.
 *  5. **UTF-8.** Excel on Windows reads a CSV with no byte-order mark in the
 *     legacy ANSI codepage, so `Montréal` arrives as `MontrÃ©al` and `Genève`
 *     as `GenÃ¨ve`. A leading U+FEFF makes it read UTF-8. Nothing else in the
 *     format announces the encoding.
 *  6. **Line endings.** RFC 4180 specifies CRLF, and older Excel builds on
 *     Windows need it.
 *
 * The output is round-trip parseable: every string in gives the same string
 * back, apart from the deliberate apostrophe on formula-shaped values.
 */

import {
  csvCell,
  type CellValue,
  type ExportColumn,
  type ExportDataset,
  type ExportRow,
} from './dataset';

/** U+FEFF, written as an escape so it survives copy-paste and diff tools.
 *  Encoded as UTF-8 it becomes the three bytes EF BB BF. */
export const UTF8_BOM = '\uFEFF';

/** RFC 4180 §2.1: records are separated by CRLF. */
export const CSV_ROW_SEPARATOR = '\r\n';

export const CSV_DELIMITER = ',';

/** What a spreadsheet consumes silently while disarming the cell. */
export const FORMULA_GUARD = "'";

export interface CsvOptions {
  /** Field separator. Comma unless a locale forces a semicolon. */
  delimiter?: string;
  /** Prepend the UTF-8 BOM. On by default — the file is for Excel. */
  bom?: boolean;
  /** Disarm formula-shaped values. On by default; turn it off only for data
   *  that will never be opened in a spreadsheet. */
  guardFormulas?: boolean;
  rowSeparator?: string;
}

interface ResolvedOptions {
  delimiter: string;
  bom: boolean;
  guardFormulas: boolean;
  rowSeparator: string;
}

function resolve(options: CsvOptions = {}): ResolvedOptions {
  return {
    delimiter: options.delimiter ?? CSV_DELIMITER,
    bom: options.bom ?? true,
    guardFormulas: options.guardFormulas ?? true,
    rowSeparator: options.rowSeparator ?? CSV_ROW_SEPARATOR,
  };
}

/**
 * A value that is unambiguously a number, so the formula guard can leave it
 * alone. Without this exemption every negative amount ("-49.00") would be
 * exported as the text `'-49.00` and every sum in the spreadsheet would be
 * wrong — the guard would have broken more than it fixed.
 *
 * `-49.00` is a number to a spreadsheet. `-49+cmd|'/C calc'!A0` is not, and
 * fails this test at the `+`.
 */
const NUMERIC = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Characters that begin a formula in Excel / LibreOffice / Google Sheets.
 *
 * TAB and CR are included because a leading control character can be stripped
 * on paste, promoting the character behind it to the front of the cell.
 */
const FORMULA_STARTERS = new Set(['=', '+', '-', '@', '\t', '\r']);

/** Whether a spreadsheet would try to evaluate this text. */
export function looksLikeFormula(value: string): boolean {
  if (value.length === 0) return false;
  if (!FORMULA_STARTERS.has(value[0])) return false;
  // A plain number is safe and must stay numeric.
  return !NUMERIC.test(value);
}

/** Whether RFC 4180 requires this field to be quoted. */
export function needsQuoting(value: string, delimiter: string = CSV_DELIMITER): boolean {
  if (value.length === 0) return false;
  if (value.includes(delimiter) || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return true;
  }
  // Not required by the RFC, but leading or trailing whitespace is silently
  // trimmed by several parsers; quoting preserves the value exactly.
  return value !== value.trim();
}

/**
 * Escape one already-stringified field.
 *
 * Order matters: guard the formula first, quote second. Doing it the other way
 * round puts the apostrophe outside the quotes, where the spreadsheet shows it
 * instead of consuming it.
 */
export function escapeCsvField(value: string, options: CsvOptions = {}): string {
  const settings = resolve(options);

  let field = value;
  if (settings.guardFormulas && looksLikeFormula(field)) {
    field = `${FORMULA_GUARD}${field}`;
  }

  if (!needsQuoting(field, settings.delimiter)) return field;
  return `"${field.replace(/"/g, '""')}"`;
}

/**
 * Stringify a raw value the way an untyped caller would expect. Typed cells go
 * through `csvCell` in dataset.ts instead, which knows about cents and dates.
 */
export function stringifyValue(value: CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return String(value);
}

/** Serialize one record. No trailing separator, no line ending. */
export function csvRow(values: readonly CellValue[], options: CsvOptions = {}): string {
  const settings = resolve(options);
  return values
    .map((value) => escapeCsvField(stringifyValue(value), settings))
    .join(settings.delimiter);
}

/** Serialize a header row plus body rows from raw arrays. */
export function csvFromArrays(
  header: readonly string[],
  rows: readonly (readonly CellValue[])[],
  options: CsvOptions = {},
): string {
  const settings = resolve(options);
  const lines = [csvRow(header, settings), ...rows.map((row) => csvRow(row, settings))];
  return (settings.bom ? UTF8_BOM : '') + lines.join(settings.rowSeparator) + settings.rowSeparator;
}

/** Serialize typed columns and row records — the normal entry point. */
export function toCsv(
  columns: readonly ExportColumn[],
  rows: readonly ExportRow[],
  options: CsvOptions = {},
): string {
  const settings = resolve(options);
  const header = columns.map((column) => column.header);
  const body = rows.map((row) => columns.map((column) => csvCell(row[column.key], column.kind)));
  return csvFromArrays(header, body, settings);
}

/**
 * Serialize a whole dataset, including its extra sections.
 *
 * There is deliberately no metadata preamble. A title and a "generated at"
 * line above the header would look tidy and would break every consumer:
 * `pandas.read_csv`, Excel's "Data > From Text" and Google Sheets all take the
 * first line as the header. The report's identity lives in the filename and in
 * the PDF; the CSV starts with column names and stays machine-readable.
 *
 * Sections are appended after a blank line with their own title row. That is a
 * compromise — one CSV holding several tables is not RFC 4180's model — but
 * the alternative is a zip of files, and a single analytics download is worth
 * more to a user than formal purity. Only analytics uses sections; the
 * applications, matches and invoices exports are a single clean table.
 */
export function datasetToCsv(dataset: ExportDataset, options: CsvOptions = {}): string {
  const settings = resolve(options);
  const blocks: string[] = [toCsv(dataset.columns, dataset.rows, { ...settings, bom: false })];

  for (const section of dataset.sections) {
    blocks.push(
      csvRow([section.title], settings) +
        settings.rowSeparator +
        toCsv(section.columns, section.rows, { ...settings, bom: false }),
    );
  }

  if (dataset.note) {
    blocks.push(csvRow([dataset.note], settings) + settings.rowSeparator);
  }

  return (settings.bom ? UTF8_BOM : '') + blocks.join(settings.rowSeparator);
}

/**
 * Minimal RFC 4180 parser.
 *
 * Exported because it is what proves the serializer: the tests round-trip
 * every awkward value through `toCsv` and back, which catches escaping bugs
 * that eyeballing the output does not. It is also genuinely useful for
 * verifying a generated file in a script.
 */
export function parseCsv(text: string, options: CsvOptions = {}): string[][] {
  const settings = resolve(options);
  const input = text.startsWith(UTF8_BOM) ? text.slice(UTF8_BOM.length) : text;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let index = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (index < input.length) {
    const char = input[index];

    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"' && field.length === 0) {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === settings.delimiter) {
      endField();
      index += 1;
      continue;
    }
    if (char === '\r' && input[index + 1] === '\n') {
      endRow();
      index += 2;
      continue;
    }
    if (char === '\n' || char === '\r') {
      endRow();
      index += 1;
      continue;
    }

    field += char;
    index += 1;
  }

  // A trailing row separator ends the last record; anything else means the
  // file ended mid-record and that partial record still counts.
  if (field.length > 0 || row.length > 0) endRow();

  return rows;
}
