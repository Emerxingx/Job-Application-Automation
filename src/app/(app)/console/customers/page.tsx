import { db } from '@/lib/db';
import { PageHeader } from '@/components/ui';
import {
  isCustomerSort,
  listCustomers,
  parseRiskFilter,
  parseStageFilter,
} from '@/lib/crm/customers';
import { consoleGate } from '../guard';
import { AccessDenied, day, since } from '../ui';
import { CustomerBrowser, type CustomerRowView } from './customer-browser';

export const metadata = { title: 'Customers' };
export const dynamic = 'force-dynamic';

/**
 * Rows per request.
 *
 * Fifty is a compromise between two failure modes. Smaller, and staff page
 * through a book of a few hundred accounts constantly. Larger, and every filter
 * change re-computes risk and six grouped aggregates for rows nobody scrolls
 * to — `listCustomers` does one aggregate pass per page, not per row, but the
 * pass still costs what it costs.
 */
const PAGE_SIZE = 50;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Query strings can repeat a key; take the first and ignore the rest. */
function one(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

const INTERVAL_LABEL: Record<string, string> = {
  monthly: 'Billed monthly',
  quarterly: 'Billed quarterly',
  annual: 'Billed annually',
};

export default async function ConsoleCustomersPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const gate = await consoleGate('support');
  if (!gate.ok) return <AccessDenied />;

  const params = await searchParams;
  const q = one(params.q).trim();
  const stage = one(params.stage);
  const risk = one(params.risk);
  const plan = one(params.plan);
  const segment = one(params.segment);
  const sortParam = one(params.sort);
  const pageParam = Number.parseInt(one(params.page), 10);

  const now = new Date();

  const [result, plans] = await Promise.all([
    listCustomers(
      {
        search: q || undefined,
        stage: parseStageFilter(stage || null),
        risk: parseRiskFilter(risk || null),
        planCode: plan || undefined,
        segment: segment || undefined,
        sort: isCustomerSort(sortParam) ? sortParam : undefined,
        page: Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1,
        pageSize: PAGE_SIZE,
      },
      now,
    ),
    db.plan.findMany({ orderBy: { sortOrder: 'asc' }, select: { code: true, name: true } }),
  ]);

  const rows: CustomerRowView[] = result.rows.map((row) => ({
    userId: row.userId,
    // An anonymised account has a scrubbed name; falling back to the email keeps
    // the row identifiable to staff without resurrecting the erased value.
    name: row.fullName || row.email,
    email: row.email,
    location: row.city ? `${row.city}, ${row.country}` : row.country,
    planLabel: row.planName ?? 'No subscription',
    intervalLabel: row.interval ? (INTERVAL_LABEL[row.interval] ?? row.interval) : '',
    view: row.view,
    risk: row.risk,
    // The tooltip on the health score: why this account scores what it does,
    // in the words the rule book uses, so nobody has to read the source.
    riskSummary:
      row.riskReasons.length > 0
        ? row.riskReasons.map((reason) => `${reason.label}: ${reason.detail}`).join('\n')
        : 'No risk signals firing.',
    mrrCents: row.mrrCents,
    currency: 'CAD',
    applicationsUsed: row.applicationsUsed,
    applicationsLimit: row.applicationsLimit,
    applicationsLast30Days: row.applicationsLast30Days,
    joinedIso: row.signedUpAt.toISOString(),
    joinedLabel: day(row.signedUpAt),
    lastActiveIso: row.lastActivityAt ? row.lastActivityAt.toISOString() : null,
    lastActiveLabel: row.lastActivityAt ? since(row.lastActivityAt, now) : 'Never',
    healthScore: row.healthScore,
    vip: row.vip,
    openTickets: row.openTickets,
    anonymized: row.anonymized,
  }));

  return (
    <>
      <PageHeader
        title="Customers"
        description="Every account, with the lifecycle stage and churn risk computed live rather than read from last night's cache."
      />

      <CustomerBrowser
        rows={rows}
        plans={plans}
        filters={{ q, stage, risk, plan, segment, sort: sortParam }}
        page={result.page}
        pageCount={result.pageCount}
        total={result.total}
        truncated={result.truncated}
      />
    </>
  );
}
