/**
 * Dataset builders.
 *
 * Each export comes in two halves:
 *
 *   `<name>Dataset(records, options)`  pure — records in, `ExportDataset` out
 *   `build<Name>Export(userId, options)`  loads the records, then delegates
 *
 * The split is what makes the shaping testable without a database, and it
 * keeps every ownership rule in one place: the loaders below are the only code
 * that decides what a user is allowed to export, and every one of them filters
 * on `userId`.
 */

import { db } from '../db';
import { parseJson } from '../types';
import {
  formatCentsDisplay,
  humanizeToken,
  type ExportColumn,
  type ExportDataset,
  type ExportRow,
  type ExportSection,
  type ExportStat,
} from './dataset';
import {
  describeRange,
  rangeFilter,
  rangeFilters,
  rangeSlug,
  UNBOUNDED_RANGE,
  type ExportRange,
} from './range';

/**
 * Hard cap on rows in one export.
 *
 * A PDF of 40,000 rows is 600 pages nobody reads, and building it holds every
 * row plus its rendered cells in memory at once. Hitting the cap is reported
 * in the file itself rather than silently truncating.
 */
export const MAX_EXPORT_ROWS = 5000;

/** Analytics aggregates rather than lists, so it may scan more rows. */
export const MAX_ANALYTICS_ROWS = 20000;

export interface BuildOptions {
  range?: ExportRange;
  generatedAt?: Date;
  limit?: number;
  /** Set by a loader that found more rows than the cap allows. */
  truncated?: boolean;
}

interface ResolvedBuildOptions {
  range: ExportRange;
  generatedAt: Date;
  limit: number;
  truncated: boolean;
}

function resolveOptions(options: BuildOptions = {}, defaultLimit = MAX_EXPORT_ROWS): ResolvedBuildOptions {
  return {
    range: options.range ?? UNBOUNDED_RANGE,
    generatedAt: options.generatedAt ?? new Date(),
    limit: Math.max(1, Math.min(options.limit ?? defaultLimit, defaultLimit)),
    truncated: options.truncated ?? false,
  };
}

/**
 * The warning printed into a capped export.
 *
 * Driven by a flag from the loader rather than by `rows.length === limit`,
 * which cannot tell "exactly 5,000 rows exist" from "more than 5,000 exist"
 * and would cry wolf on the former. Loaders fetch one row past the cap to
 * settle it.
 */
function truncationNote(options: ResolvedBuildOptions): string | undefined {
  if (!options.truncated) return undefined;
  return `Only the first ${options.limit.toLocaleString('en-CA')} rows are included. Narrow the date range with ?from= and ?to= to export the rest.`;
}

/** Apply the cap, reporting whether anything was cut. */
function capRows<T>(records: T[], limit: number): { rows: T[]; truncated: boolean } {
  if (records.length <= limit) return { rows: records, truncated: false };
  return { rows: records.slice(0, limit), truncated: true };
}

// ---------------------------------------------------------------------------
// Small formatting helpers
// ---------------------------------------------------------------------------

/** A whole-dollar salary band: "CAD 90,000 – 110,000". */
export function formatSalaryBand(
  min: number | null | undefined,
  max: number | null | undefined,
  currency: string,
): string {
  const group = (value: number) => Math.round(value).toLocaleString('en-CA');
  if (min && max) return `${currency} ${group(min)} – ${group(max)}`;
  if (min) return `${currency} ${group(min)}+`;
  if (max) return `${currency} up to ${group(max)}`;
  return '';
}

/** A percentage of a whole, in percent units, safe when the whole is zero. */
export function percentOf(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return (part / whole) * 100;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** JSON string column -> a readable cell. */
function keywordCell(json: string, max = 12): string {
  const keywords = parseJson<string[]>(json, []);
  if (!Array.isArray(keywords) || keywords.length === 0) return '';
  const shown = keywords.slice(0, max).join('; ');
  return keywords.length > max ? `${shown}; +${keywords.length - max} more` : shown;
}

/** `YYYY-MM` in UTC, for the monthly analytics breakdown. */
function monthKey(value: Date): string {
  return value.toISOString().slice(0, 7);
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

/** The job fields every export shares. Structurally a subset of Prisma's `Job`. */
export interface ExportJobFields {
  title: string;
  company: string;
  location: string;
  country: string;
  workMode: string;
  jobType: string;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string;
  applyUrl: string;
  postedAt: Date;
}

export interface ApplicationExportRecord {
  id: string;
  status: string;
  matchScore: number;
  atsScore: number;
  applyChannel: string;
  atsVendor: string | null;
  confirmation: string | null;
  notes: string;
  failureReason: string | null;
  appliedAt: Date | null;
  respondedAt: Date | null;
  createdAt: Date;
  job: ExportJobFields;
  agent: { name: string } | null;
}

/**
 * Statuses that mean the application reached the employer.
 *
 * `ready_to_submit` has not; `failed` did not; `withdrawn` is ambiguous and is
 * left out so the submitted count can never overstate what was actually sent.
 */
export const SUBMITTED_STATUSES = new Set(['submitted', 'interviewing', 'offer', 'rejected']);

export const APPLICATION_COLUMNS: ExportColumn[] = [
  { key: 'company', header: 'Company', width: 2 },
  { key: 'title', header: 'Job title', width: 2.6 },
  { key: 'location', header: 'Location', width: 1.6 },
  { key: 'status', header: 'Status', width: 1.2 },
  { key: 'matchScore', header: 'Match', kind: 'number', width: 0.8 },
  { key: 'appliedAt', header: 'Applied', kind: 'date', width: 1.2 },
  // --- CSV only, from here down ---
  { key: 'atsScore', header: 'ATS score', kind: 'number', csvOnly: true },
  { key: 'createdAt', header: 'Created', kind: 'date', csvOnly: true },
  { key: 'respondedAt', header: 'Responded', kind: 'date', csvOnly: true },
  { key: 'agent', header: 'Agent', csvOnly: true },
  { key: 'channel', header: 'Apply channel', csvOnly: true },
  { key: 'atsVendor', header: 'ATS vendor', csvOnly: true },
  { key: 'confirmation', header: 'Confirmation', csvOnly: true },
  { key: 'workMode', header: 'Work mode', csvOnly: true },
  { key: 'jobType', header: 'Job type', csvOnly: true },
  { key: 'country', header: 'Country', csvOnly: true },
  { key: 'salary', header: 'Salary', csvOnly: true },
  { key: 'postedAt', header: 'Posted', kind: 'date', csvOnly: true },
  { key: 'applyUrl', header: 'Job URL', csvOnly: true },
  { key: 'failureReason', header: 'Failure reason', csvOnly: true },
  { key: 'notes', header: 'Notes', csvOnly: true },
];

export function applicationRow(record: ApplicationExportRecord): ExportRow {
  return {
    company: record.job.company,
    title: record.job.title,
    location: record.job.location,
    status: humanizeToken(record.status),
    matchScore: record.matchScore,
    appliedAt: record.appliedAt,
    atsScore: record.atsScore,
    createdAt: record.createdAt,
    respondedAt: record.respondedAt,
    agent: record.agent?.name ?? '',
    channel: humanizeToken(record.applyChannel),
    atsVendor: record.atsVendor ?? '',
    confirmation: record.confirmation ?? '',
    workMode: humanizeToken(record.job.workMode),
    jobType: humanizeToken(record.job.jobType),
    country: record.job.country,
    salary: formatSalaryBand(record.job.salaryMin, record.job.salaryMax, record.job.salaryCurrency),
    postedAt: record.job.postedAt,
    applyUrl: record.job.applyUrl,
    failureReason: record.failureReason ?? '',
    notes: record.notes,
  };
}

export function applicationsDataset(
  records: readonly ApplicationExportRecord[],
  options: BuildOptions = {},
): ExportDataset {
  const resolved = resolveOptions(options);
  const { range, generatedAt } = resolved;

  const submitted = records.filter((record) => SUBMITTED_STATUSES.has(record.status));
  const responded = records.filter((record) => record.respondedAt !== null);
  const interviews = records.filter(
    (record) => record.status === 'interviewing' || record.status === 'offer',
  );
  const offers = records.filter((record) => record.status === 'offer');

  const summary: ExportStat[] = [
    { label: 'Applications', value: records.length.toLocaleString('en-CA') },
    { label: 'Submitted', value: submitted.length.toLocaleString('en-CA') },
    { label: 'Responses', value: responded.length.toLocaleString('en-CA') },
    {
      label: 'Interviews',
      value: interviews.length.toLocaleString('en-CA'),
    },
    { label: 'Offers', value: offers.length.toLocaleString('en-CA') },
    {
      label: 'Average match',
      value: records.length
        ? `${average(records.map((record) => record.matchScore)).toFixed(0)}%`
        : '—',
    },
  ];

  return {
    title: 'Applications',
    subtitle: 'Every application JobPilot has prepared or submitted on your behalf.',
    filenameBase: `jobpilot-applications_${rangeSlug(range, generatedAt)}`,
    generatedAt,
    filters: rangeFilters(range),
    summary,
    columns: APPLICATION_COLUMNS,
    rows: records.map(applicationRow),
    sections: [],
    emptyMessage: `No applications in ${describeRange(range).toLowerCase()}.`,
    note: truncationNote(resolved),
  };
}

/** Load and shape the signed-in user's applications. */
export async function buildApplicationsExport(
  userId: string,
  options: BuildOptions = {},
): Promise<ExportDataset> {
  const resolved = resolveOptions(options);
  const window = rangeFilter(resolved.range);

  const records = await db.application.findMany({
    // An application's date is the day it went out; queued and failed ones
    // never went out, so they fall back to the day they were created. Filtering
    // on createdAt alone would drop an application queued in March and sent in
    // April from an April export.
    where: window
      ? {
          userId,
          OR: [{ appliedAt: window }, { AND: [{ appliedAt: null }, { createdAt: window }] }],
        }
      : { userId },
    include: { job: true, agent: { select: { name: true } } },
    orderBy: [{ appliedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    // One past the cap, so the note can say truthfully whether anything was cut.
    take: resolved.limit + 1,
  });

  const { rows, truncated } = capRows(records, resolved.limit);
  return applicationsDataset(rows, { ...resolved, truncated });
}

// ---------------------------------------------------------------------------
// Job matches
// ---------------------------------------------------------------------------

export interface JobMatchExportRecord {
  matchScore: number;
  status: string;
  rationale: string;
  matchedKeywords: string;
  missingKeywords: string;
  createdAt: Date;
  job: ExportJobFields;
  agent: { name: string };
}

export const JOB_MATCH_COLUMNS: ExportColumn[] = [
  { key: 'company', header: 'Company', width: 2 },
  { key: 'title', header: 'Job title', width: 2.6 },
  { key: 'location', header: 'Location', width: 1.6 },
  { key: 'matchScore', header: 'Match', kind: 'number', width: 0.8 },
  { key: 'status', header: 'Status', width: 1.1 },
  { key: 'createdAt', header: 'Found', kind: 'date', width: 1.2 },
  // --- CSV only ---
  { key: 'agent', header: 'Agent', csvOnly: true },
  { key: 'workMode', header: 'Work mode', csvOnly: true },
  { key: 'jobType', header: 'Job type', csvOnly: true },
  { key: 'country', header: 'Country', csvOnly: true },
  { key: 'salary', header: 'Salary', csvOnly: true },
  { key: 'postedAt', header: 'Posted', kind: 'date', csvOnly: true },
  { key: 'matchedKeywords', header: 'Matched keywords', csvOnly: true },
  { key: 'missingKeywords', header: 'Missing keywords', csvOnly: true },
  { key: 'rationale', header: 'Why it matched', csvOnly: true },
  { key: 'applyUrl', header: 'Job URL', csvOnly: true },
];

export function jobMatchRow(record: JobMatchExportRecord): ExportRow {
  return {
    company: record.job.company,
    title: record.job.title,
    location: record.job.location,
    matchScore: record.matchScore,
    status: humanizeToken(record.status),
    createdAt: record.createdAt,
    agent: record.agent.name,
    workMode: humanizeToken(record.job.workMode),
    jobType: humanizeToken(record.job.jobType),
    country: record.job.country,
    salary: formatSalaryBand(record.job.salaryMin, record.job.salaryMax, record.job.salaryCurrency),
    postedAt: record.job.postedAt,
    matchedKeywords: keywordCell(record.matchedKeywords),
    missingKeywords: keywordCell(record.missingKeywords),
    rationale: record.rationale,
    applyUrl: record.job.applyUrl,
  };
}

export function jobMatchesDataset(
  records: readonly JobMatchExportRecord[],
  options: BuildOptions = {},
): ExportDataset {
  const resolved = resolveOptions(options);
  const { range, generatedAt } = resolved;
  const scores = records.map((record) => record.matchScore);
  const strong = records.filter((record) => record.matchScore >= 85);

  return {
    title: 'Job matches',
    subtitle: 'Postings your agents scored against your resume.',
    filenameBase: `jobpilot-job-matches_${rangeSlug(range, generatedAt)}`,
    generatedAt,
    filters: rangeFilters(range),
    summary: [
      { label: 'Matches', value: records.length.toLocaleString('en-CA') },
      { label: 'Average score', value: records.length ? `${average(scores).toFixed(0)}%` : '—' },
      { label: 'Strong (85+)', value: strong.length.toLocaleString('en-CA') },
    ],
    columns: JOB_MATCH_COLUMNS,
    rows: records.map(jobMatchRow),
    sections: [],
    emptyMessage: `No job matches in ${describeRange(range).toLowerCase()}.`,
    note: truncationNote(resolved),
  };
}

/** Load and shape the user's matches. Matches hang off agents, so ownership is
 *  enforced through the agent relation. */
export async function buildJobMatchesExport(
  userId: string,
  options: BuildOptions = {},
): Promise<ExportDataset> {
  const resolved = resolveOptions(options);
  const window = rangeFilter(resolved.range);

  const records = await db.jobMatch.findMany({
    where: { agent: { userId }, ...(window ? { createdAt: window } : {}) },
    include: { job: true, agent: { select: { name: true } } },
    orderBy: [{ matchScore: 'desc' }, { createdAt: 'desc' }],
    take: resolved.limit + 1,
  });

  const { rows, truncated } = capRows(records, resolved.limit);
  return jobMatchesDataset(rows, { ...resolved, truncated });
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export interface InvoiceExportRecord {
  number: string | null;
  status: string;
  currency: string;
  planName: string;
  interval: string;
  issuedAt: Date | null;
  dueAt: Date | null;
  paidAt: Date | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  amountPaidCents: number;
  amountCreditedCents: number;
  amountRefundedCents: number;
  amountDueCents: number;
}

export const INVOICE_COLUMNS: ExportColumn[] = [
  { key: 'number', header: 'Invoice', width: 1.5 },
  { key: 'issuedAt', header: 'Issued', kind: 'date', width: 1.2 },
  { key: 'planName', header: 'Plan', width: 1.6 },
  { key: 'status', header: 'Status', width: 1 },
  { key: 'totalCents', header: 'Total', kind: 'money', width: 1.1 },
  { key: 'amountDueCents', header: 'Amount due', kind: 'money', width: 1.1 },
  // --- CSV only ---
  { key: 'currency', header: 'Currency', csvOnly: true },
  { key: 'interval', header: 'Billing interval', csvOnly: true },
  { key: 'dueAt', header: 'Due', kind: 'date', csvOnly: true },
  { key: 'paidAt', header: 'Paid on', kind: 'date', csvOnly: true },
  { key: 'periodStart', header: 'Service period start', kind: 'date', csvOnly: true },
  { key: 'periodEnd', header: 'Service period end', kind: 'date', csvOnly: true },
  { key: 'subtotalCents', header: 'Subtotal', kind: 'money', csvOnly: true },
  { key: 'discountCents', header: 'Discount', kind: 'money', csvOnly: true },
  { key: 'taxCents', header: 'Tax', kind: 'money', csvOnly: true },
  { key: 'amountPaidCents', header: 'Paid', kind: 'money', csvOnly: true },
  { key: 'amountCreditedCents', header: 'Credited', kind: 'money', csvOnly: true },
  { key: 'amountRefundedCents', header: 'Refunded', kind: 'money', csvOnly: true },
];

export function invoiceRow(record: InvoiceExportRecord): ExportRow {
  return {
    // A draft carries no number by design; it should never reach an export,
    // but if one does it is labelled rather than shown as an empty cell.
    number: record.number ?? 'Draft',
    issuedAt: record.issuedAt,
    planName: record.planName,
    status: humanizeToken(record.status),
    totalCents: record.totalCents,
    amountDueCents: record.amountDueCents,
    currency: record.currency,
    interval: humanizeToken(record.interval),
    dueAt: record.dueAt,
    paidAt: record.paidAt,
    periodStart: record.periodStart,
    periodEnd: record.periodEnd,
    subtotalCents: record.subtotalCents,
    discountCents: record.discountCents,
    taxCents: record.taxCents,
    amountPaidCents: record.amountPaidCents,
    amountCreditedCents: record.amountCreditedCents,
    amountRefundedCents: record.amountRefundedCents,
  };
}

/** Totals per currency. Currencies are never summed together — an invoice in
 *  USD and one in CAD do not add up to anything meaningful. */
export function invoiceTotalsByCurrency(records: readonly InvoiceExportRecord[]) {
  const totals = new Map<
    string,
    { currency: string; count: number; invoicedCents: number; paidCents: number; dueCents: number; taxCents: number }
  >();

  for (const record of records) {
    const entry = totals.get(record.currency) ?? {
      currency: record.currency,
      count: 0,
      invoicedCents: 0,
      paidCents: 0,
      dueCents: 0,
      taxCents: 0,
    };
    entry.count += 1;
    entry.invoicedCents += record.totalCents;
    entry.paidCents += record.amountPaidCents;
    entry.dueCents += record.amountDueCents;
    entry.taxCents += record.taxCents;
    totals.set(record.currency, entry);
  }

  return [...totals.values()].sort((a, b) => b.invoicedCents - a.invoicedCents);
}

export function invoicesDataset(
  records: readonly InvoiceExportRecord[],
  options: BuildOptions = {},
): ExportDataset {
  const resolved = resolveOptions(options);
  const { range, generatedAt } = resolved;
  const totals = invoiceTotalsByCurrency(records);

  const summary: ExportStat[] = [
    { label: 'Invoices', value: records.length.toLocaleString('en-CA') },
  ];
  for (const total of totals) {
    summary.push({ label: `Invoiced (${total.currency})`, value: formatCentsDisplay(total.invoicedCents) });
    summary.push({ label: `Outstanding (${total.currency})`, value: formatCentsDisplay(total.dueCents) });
  }

  const sections: ExportSection[] =
    totals.length > 0
      ? [
          {
            title: 'Totals by currency',
            columns: [
              { key: 'currency', header: 'Currency', width: 1 },
              { key: 'count', header: 'Invoices', kind: 'number', width: 1 },
              { key: 'invoicedCents', header: 'Invoiced', kind: 'money', width: 1.2 },
              { key: 'taxCents', header: 'Tax', kind: 'money', width: 1.2 },
              { key: 'paidCents', header: 'Paid', kind: 'money', width: 1.2 },
              { key: 'dueCents', header: 'Outstanding', kind: 'money', width: 1.2 },
            ],
            rows: totals.map((total) => ({ ...total })),
          },
        ]
      : [];

  return {
    title: 'Invoices',
    subtitle: 'Issued invoices on your JobPilot AI account. Drafts are not included.',
    filenameBase: `jobpilot-invoices_${rangeSlug(range, generatedAt)}`,
    generatedAt,
    filters: rangeFilters(range),
    summary,
    columns: INVOICE_COLUMNS,
    rows: records.map(invoiceRow),
    sections,
    emptyMessage: 'No issued invoices for this account.',
    note: truncationNote(resolved),
  };
}

/** Load and shape the user's issued invoices. */
export async function buildInvoicesExport(
  userId: string,
  options: BuildOptions = {},
): Promise<ExportDataset> {
  const resolved = resolveOptions(options);
  const window = rangeFilter(resolved.range);

  const records = await db.invoice.findMany({
    // Drafts have no number, no issue date and are still mutable — they are not
    // documents the customer has been given, exactly as /api/invoices decides.
    where: { userId, status: { not: 'draft' }, ...(window ? { issuedAt: window } : {}) },
    orderBy: [{ issuedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    take: resolved.limit + 1,
  });

  const { rows, truncated } = capRows(records, resolved.limit);
  return invoicesDataset(rows, { ...resolved, truncated });
}

// ---------------------------------------------------------------------------
// Analytics summary
// ---------------------------------------------------------------------------

export interface AnalyticsApplicationRow {
  status: string;
  matchScore: number;
  atsScore: number;
  createdAt: Date;
  appliedAt: Date | null;
  respondedAt: Date | null;
  job: { company: string };
}

export interface AnalyticsMatchRow {
  matchScore: number;
  status: string;
  createdAt: Date;
}

export interface AnalyticsSubscriptionRow {
  status: string;
  interval: string;
  applicationsUsed: number;
  periodEnd: Date;
  plan: { name: string; applicationsPerMonth: number };
}

export interface AnalyticsInput {
  applications: readonly AnalyticsApplicationRow[];
  matches: readonly AnalyticsMatchRow[];
  invoices: readonly InvoiceExportRecord[];
  subscription: AnalyticsSubscriptionRow | null;
}

const METRIC_COLUMNS: ExportColumn[] = [
  { key: 'metric', header: 'Metric', width: 3 },
  { key: 'value', header: 'Value', width: 1.4, align: 'right' },
];

/**
 * The analytics dataset: a metric/value table plus breakdown sections.
 *
 * The headline table is metric-per-row rather than one wide row so the CSV is
 * readable as a spreadsheet and the PDF as a page. Everything is computed from
 * the rows handed in — this function performs no queries and no rounding
 * beyond display, so the same input always produces the same report.
 */
export function analyticsDataset(input: AnalyticsInput, options: BuildOptions = {}): ExportDataset {
  const { range, generatedAt } = resolveOptions(options, MAX_ANALYTICS_ROWS);
  const { applications, matches, invoices, subscription } = input;

  const submitted = applications.filter((row) => SUBMITTED_STATUSES.has(row.status));
  const responded = applications.filter((row) => row.respondedAt !== null);
  const interviews = applications.filter(
    (row) => row.status === 'interviewing' || row.status === 'offer',
  );
  const offers = applications.filter((row) => row.status === 'offer');
  const rejections = applications.filter((row) => row.status === 'rejected');

  const responseRate = percentOf(responded.length, submitted.length);
  const interviewRate = percentOf(interviews.length, submitted.length);
  const offerRate = percentOf(offers.length, submitted.length);

  // Only applications that were both sent and answered can measure a wait.
  const responseDays = applications
    .filter((row) => row.respondedAt && row.appliedAt)
    .map((row) => (row.respondedAt!.getTime() - row.appliedAt!.getTime()) / 86_400_000)
    .filter((days) => days >= 0);

  const matchScores = matches.map((row) => row.matchScore);
  const strongMatches = matches.filter((row) => row.matchScore >= 85);

  const metricRows: ExportRow[] = [
    { metric: 'Applications created', value: applications.length.toLocaleString('en-CA') },
    { metric: 'Applications submitted', value: submitted.length.toLocaleString('en-CA') },
    { metric: 'Employer responses', value: responded.length.toLocaleString('en-CA') },
    { metric: 'Response rate', value: `${responseRate.toFixed(1)}%` },
    { metric: 'Interviews', value: interviews.length.toLocaleString('en-CA') },
    { metric: 'Interview rate', value: `${interviewRate.toFixed(1)}%` },
    { metric: 'Offers', value: offers.length.toLocaleString('en-CA') },
    { metric: 'Offer rate', value: `${offerRate.toFixed(1)}%` },
    { metric: 'Rejections', value: rejections.length.toLocaleString('en-CA') },
    {
      metric: 'Average days to response',
      value: responseDays.length ? average(responseDays).toFixed(1) : '—',
    },
    {
      metric: 'Average match score',
      value: applications.length
        ? `${average(applications.map((row) => row.matchScore)).toFixed(0)}%`
        : '—',
    },
    {
      metric: 'Average ATS score',
      value: applications.length
        ? `${average(applications.map((row) => row.atsScore)).toFixed(0)}%`
        : '—',
    },
    { metric: 'Jobs matched', value: matches.length.toLocaleString('en-CA') },
    {
      metric: 'Average match quality',
      value: matches.length ? `${average(matchScores).toFixed(0)}%` : '—',
    },
    { metric: 'Strong matches (85+)', value: strongMatches.length.toLocaleString('en-CA') },
  ];

  if (subscription) {
    const allowance = subscription.plan.applicationsPerMonth;
    metricRows.push(
      { metric: 'Plan', value: `${subscription.plan.name} (${subscription.interval})` },
      { metric: 'Subscription status', value: humanizeToken(subscription.status) },
      {
        metric: 'Applications used this cycle',
        value: `${subscription.applicationsUsed.toLocaleString('en-CA')} of ${allowance.toLocaleString('en-CA')}`,
      },
    );
  }

  return {
    title: 'Job search analytics',
    subtitle: 'Funnel, match quality and billing summary for the selected period.',
    filenameBase: `jobpilot-analytics_${rangeSlug(range, generatedAt)}`,
    generatedAt,
    filters: rangeFilters(range),
    summary: [
      { label: 'Applications', value: applications.length.toLocaleString('en-CA') },
      { label: 'Submitted', value: submitted.length.toLocaleString('en-CA') },
      { label: 'Response rate', value: `${responseRate.toFixed(1)}%` },
      { label: 'Interviews', value: interviews.length.toLocaleString('en-CA') },
      { label: 'Offers', value: offers.length.toLocaleString('en-CA') },
      { label: 'Jobs matched', value: matches.length.toLocaleString('en-CA') },
    ],
    columns: METRIC_COLUMNS,
    rows: metricRows,
    sections: [
      statusSection(applications),
      companySection(applications),
      monthlySection(applications),
      billingSection(invoices),
    ],
    emptyMessage: `No activity in ${describeRange(range).toLowerCase()}.`,
  };
}

function statusSection(applications: readonly AnalyticsApplicationRow[]): ExportSection {
  const counts = new Map<string, number>();
  for (const row of applications) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);

  const rows = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([status, count]) => ({
      status: humanizeToken(status),
      count,
      share: percentOf(count, applications.length),
    }));

  return {
    title: 'Applications by status',
    columns: [
      { key: 'status', header: 'Status', width: 2 },
      { key: 'count', header: 'Applications', kind: 'number', width: 1 },
      { key: 'share', header: 'Share', kind: 'percent', width: 1 },
    ],
    rows,
    emptyMessage: 'No applications in this period.',
  };
}

function companySection(applications: readonly AnalyticsApplicationRow[]): ExportSection {
  const byCompany = new Map<string, { company: string; count: number; scores: number[] }>();
  for (const row of applications) {
    const entry = byCompany.get(row.job.company) ?? { company: row.job.company, count: 0, scores: [] };
    entry.count += 1;
    entry.scores.push(row.matchScore);
    byCompany.set(row.job.company, entry);
  }

  const rows = [...byCompany.values()]
    .sort((a, b) => b.count - a.count || a.company.localeCompare(b.company))
    .slice(0, 15)
    .map((entry) => ({
      company: entry.company,
      count: entry.count,
      averageMatch: Math.round(average(entry.scores)),
    }));

  return {
    title: 'Most-applied companies',
    columns: [
      { key: 'company', header: 'Company', width: 3 },
      { key: 'count', header: 'Applications', kind: 'number', width: 1 },
      { key: 'averageMatch', header: 'Avg match', kind: 'number', width: 1 },
    ],
    rows,
    emptyMessage: 'No applications in this period.',
  };
}

function monthlySection(applications: readonly AnalyticsApplicationRow[]): ExportSection {
  const months = new Map<string, { month: string; created: number; submitted: number; responses: number }>();

  const bump = (key: string) =>
    months.get(key) ?? { month: key, created: 0, submitted: 0, responses: 0 };

  for (const row of applications) {
    const createdKey = monthKey(row.createdAt);
    const created = bump(createdKey);
    created.created += 1;
    months.set(createdKey, created);

    if (row.appliedAt && SUBMITTED_STATUSES.has(row.status)) {
      const key = monthKey(row.appliedAt);
      const entry = bump(key);
      entry.submitted += 1;
      months.set(key, entry);
    }
    if (row.respondedAt) {
      const key = monthKey(row.respondedAt);
      const entry = bump(key);
      entry.responses += 1;
      months.set(key, entry);
    }
  }

  return {
    title: 'Monthly activity',
    columns: [
      { key: 'month', header: 'Month', width: 1.4 },
      { key: 'created', header: 'Created', kind: 'number', width: 1 },
      { key: 'submitted', header: 'Submitted', kind: 'number', width: 1 },
      { key: 'responses', header: 'Responses', kind: 'number', width: 1 },
    ],
    rows: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
    emptyMessage: 'No applications in this period.',
  };
}

function billingSection(invoices: readonly InvoiceExportRecord[]): ExportSection {
  return {
    title: 'Billing',
    columns: [
      { key: 'currency', header: 'Currency', width: 1 },
      { key: 'count', header: 'Invoices', kind: 'number', width: 1 },
      { key: 'invoicedCents', header: 'Invoiced', kind: 'money', width: 1.2 },
      { key: 'paidCents', header: 'Paid', kind: 'money', width: 1.2 },
      { key: 'dueCents', header: 'Outstanding', kind: 'money', width: 1.2 },
    ],
    rows: invoiceTotalsByCurrency(invoices).map((total) => ({ ...total })),
    emptyMessage: 'No invoices in this period.',
  };
}

/** Load everything the analytics report needs, scoped to one user. */
export async function buildAnalyticsExport(
  userId: string,
  options: BuildOptions = {},
): Promise<ExportDataset> {
  const resolved = resolveOptions(options, MAX_ANALYTICS_ROWS);
  const window = rangeFilter(resolved.range);

  const [applications, matches, invoices, subscription] = await Promise.all([
    db.application.findMany({
      where: window
        ? {
            userId,
            OR: [{ appliedAt: window }, { AND: [{ appliedAt: null }, { createdAt: window }] }],
          }
        : { userId },
      select: {
        status: true,
        matchScore: true,
        atsScore: true,
        createdAt: true,
        appliedAt: true,
        respondedAt: true,
        job: { select: { company: true } },
      },
      take: resolved.limit,
    }),
    db.jobMatch.findMany({
      where: { agent: { userId }, ...(window ? { createdAt: window } : {}) },
      select: { matchScore: true, status: true, createdAt: true },
      take: resolved.limit,
    }),
    db.invoice.findMany({
      where: { userId, status: { not: 'draft' }, ...(window ? { issuedAt: window } : {}) },
      take: MAX_EXPORT_ROWS,
    }),
    db.subscription.findUnique({
      where: { userId },
      select: {
        status: true,
        interval: true,
        applicationsUsed: true,
        periodEnd: true,
        plan: { select: { name: true, applicationsPerMonth: true } },
      },
    }),
  ]);

  return analyticsDataset({ applications, matches, invoices, subscription }, resolved);
}
