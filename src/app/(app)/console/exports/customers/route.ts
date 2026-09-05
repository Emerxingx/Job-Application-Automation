import { describeWait, tooMany } from '@/lib/api';
import { rateLimit } from '@/lib/rate-limit';
import { consoleRoute, requireStaff } from '@/lib/crm/auth';
import {
  isCustomerSort,
  listCustomers,
  parseRiskFilter,
  parseStageFilter,
  type CustomerListRow,
} from '@/lib/crm/customers';
import {
  EXPORT_RATE_LIMIT,
  exportFormatSchema,
  exportResponse,
  type ExportColumn,
  type ExportDataset,
  type ExportFilter,
  type ExportRow,
} from '@/lib/exports';

/**
 * The customer book as a file.
 *
 * IT LIVES UNDER /console, NOT /api. Route Handlers do not run layouts, so this
 * file's own `requireStaff()` is the only thing standing between a session
 * cookie and a CSV of every customer's name, email and revenue. Putting it
 * beside the page it serves makes that adjacency obvious to whoever edits it
 * next; the gate below is what actually enforces it.
 *
 * The file always carries the filters the reader had on screen. An export
 * button that quietly downloads the unfiltered table is how a "list of my
 * at-risk enterprise accounts" turns into a copy of the whole database.
 */

/** Hard ceiling on rows. Beyond this the file is truncated and says so. */
const MAX_ROWS = 2000;

/** `listCustomers` caps a page at 100, so the export walks pages. */
const PAGE_SIZE = 100;

const COLUMNS: ExportColumn[] = [
  { key: 'name', header: 'Name', width: 3 },
  { key: 'email', header: 'Email', width: 3 },
  { key: 'city', header: 'City', width: 2, csvOnly: true },
  { key: 'country', header: 'Country', width: 1 },
  { key: 'plan', header: 'Plan', width: 2 },
  { key: 'interval', header: 'Interval', width: 1, csvOnly: true },
  { key: 'subscriptionStatus', header: 'Subscription', width: 2 },
  { key: 'stage', header: 'Stage', width: 1 },
  { key: 'risk', header: 'Risk', width: 1 },
  { key: 'healthScore', header: 'Health', kind: 'number', width: 1 },
  { key: 'mrrCents', header: 'MRR', kind: 'money', width: 2 },
  { key: 'lifetimeValueCents', header: 'Lifetime value', kind: 'money', width: 2 },
  { key: 'applicationsUsed', header: 'Applications used', kind: 'number', width: 1, csvOnly: true },
  { key: 'applicationsLimit', header: 'Allowance', kind: 'number', width: 1, csvOnly: true },
  { key: 'applications30d', header: 'Applications 30d', kind: 'number', width: 1 },
  { key: 'openTickets', header: 'Open tickets', kind: 'number', width: 1, csvOnly: true },
  { key: 'signedUpAt', header: 'Joined', kind: 'date', width: 2 },
  { key: 'lastActivityAt', header: 'Last active', kind: 'date', width: 2 },
  { key: 'riskReasons', header: 'Risk signals', width: 3, csvOnly: true },
  { key: 'userId', header: 'User id', width: 2, csvOnly: true },
];

function toRow(row: CustomerListRow): ExportRow {
  return {
    name: row.fullName || row.email,
    email: row.email,
    city: row.city ?? '',
    country: row.country,
    plan: row.planName ?? 'No subscription',
    interval: row.interval ?? '',
    subscriptionStatus: row.subscriptionStatus ?? 'none',
    stage: row.view,
    risk: row.risk,
    healthScore: row.healthScore,
    mrrCents: row.mrrCents,
    lifetimeValueCents: row.lifetimeValueCents,
    applicationsUsed: row.applicationsUsed,
    applicationsLimit: row.applicationsLimit,
    applications30d: row.applicationsLast30Days,
    openTickets: row.openTickets,
    signedUpAt: row.signedUpAt,
    lastActivityAt: row.lastActivityAt,
    riskReasons: row.riskReasons.map((reason) => reason.label).join('; '),
    userId: row.userId,
  };
}

export const GET = consoleRoute(async (request: Request) => {
  const staff = await requireStaff('support');

  // An export reads thousands of rows and can render a hundred-page PDF, so it
  // carries the same ceiling as the customer-facing export routes on top of the
  // staff gate.
  const limit = await rateLimit('console-export-customers', staff.id, EXPORT_RATE_LIMIT);
  if (!limit.ok) {
    return tooMany(
      `Too many exports. Try again in ${describeWait(limit.retryAfterSeconds)}.`,
      limit.retryAfterSeconds,
    );
  }

  const url = new URL(request.url);
  const format = exportFormatSchema('csv').parse(url.searchParams.get('format') ?? undefined);

  const search = url.searchParams.get('q')?.trim() || undefined;
  const stage = parseStageFilter(url.searchParams.get('stage'));
  const risk = parseRiskFilter(url.searchParams.get('risk'));
  const planCode = url.searchParams.get('plan')?.trim() || undefined;
  const segment = url.searchParams.get('segment')?.trim() || undefined;
  const sortParam = url.searchParams.get('sort');
  const sort = sortParam && isCustomerSort(sortParam) ? sortParam : undefined;

  const now = new Date();
  const rows: CustomerListRow[] = [];
  let truncated = false;
  let total = 0;

  // Walk pages rather than raising the page cap: `listCustomers` runs its
  // aggregate pass per page, and a single 2,000-row query would build six
  // `IN (…)` lists of 2,000 ids each.
  for (let page = 1; rows.length < MAX_ROWS; page += 1) {
    const result = await listCustomers(
      { search, stage, risk, planCode, segment, sort, page, pageSize: PAGE_SIZE },
      now,
    );
    total = result.total;
    rows.push(...result.rows);
    if (result.truncated) truncated = true;
    if (page >= result.pageCount || result.rows.length === 0) break;
  }

  if (rows.length > MAX_ROWS) rows.length = MAX_ROWS;
  if (total > rows.length) truncated = true;

  const filters: ExportFilter[] = [];
  if (search) filters.push({ label: 'Search', value: search });
  if (stage) filters.push({ label: 'Stage', value: stage });
  if (risk) filters.push({ label: 'Risk', value: risk });
  if (planCode) filters.push({ label: 'Plan', value: planCode });
  if (segment) filters.push({ label: 'Segment', value: segment });
  if (filters.length === 0) filters.push({ label: 'Filter', value: 'All customers' });

  const payingMrr = rows.reduce((sum, row) => sum + row.mrrCents, 0);
  const atRisk = rows.filter((row) => row.risk !== 'normal').length;

  const dataset: ExportDataset = {
    title: 'JobPilot customers',
    subtitle: `Exported by ${staff.email}`,
    filenameBase: `jobpilot-customers-${now.toISOString().slice(0, 10)}`,
    generatedAt: now,
    filters,
    summary: [
      { label: 'Customers in file', value: String(rows.length) },
      { label: 'Matching the filter', value: String(total) },
      { label: 'MRR in file (CAD)', value: (payingMrr / 100).toFixed(2) },
      { label: 'At risk or critical', value: String(atRisk) },
    ],
    columns: COLUMNS,
    rows: rows.map(toRow),
    sections: [],
    emptyMessage: 'No customers matched these filters.',
    note: truncated
      ? `Truncated to ${MAX_ROWS} rows of ${total}. Narrow the filters for a complete file.`
      : undefined,
  };

  return exportResponse(dataset, format);
});
