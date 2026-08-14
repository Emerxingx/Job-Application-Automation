'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ChevronLeft, ChevronRight, Star, TriangleAlert, Users } from 'lucide-react';
import { DataTable, formatCents, type Column } from '@/components/data-table';
import { ExportButton } from '@/components/export-button';
import { FilterBar, SearchInput, SelectFilter, useDebouncedValue } from '@/components/filters';
import { Meter, cn } from '@/components/ui';
// lib/crm/lifecycle.ts is a pure module — no database, no I/O — so its values
// are safe to import into the browser bundle. lib/crm/customers.ts is not: it
// imports the Prisma client, so the sort vocabulary below is mirrored rather
// than imported. The server re-validates every sort value with `isCustomerSort`
// and ignores anything it does not recognise, so a drifted copy degrades to the
// default ordering instead of producing a wrong query.
import { LIFECYCLE_STAGES, RISK_LEVELS, type LifecycleView, type RiskLevel } from '@/lib/crm/lifecycle';
import { Pill, RiskBadge, StageBadge } from '../ui';

const CUSTOMER_SORTS = ['recent', 'oldest', 'name', 'mrr', 'activity', 'health'] as const;

/**
 * One row of the customer book.
 *
 * Dates and money arrive already formatted. That is the house pattern (see
 * dashboard/invoices/invoice-table.tsx) and it exists for two reasons: money is
 * integer cents in the database and the client should never be the thing that
 * divides by 100, and a relative date computed on the client hydrates into a
 * different string than the one the server rendered.
 */
export interface CustomerRowView {
  userId: string;
  name: string;
  email: string;
  location: string;
  planLabel: string;
  intervalLabel: string;
  view: LifecycleView;
  risk: RiskLevel;
  riskSummary: string;
  mrrCents: number;
  currency: string;
  applicationsUsed: number;
  applicationsLimit: number;
  applicationsLast30Days: number;
  /** ISO-8601, for sorting only. */
  joinedIso: string;
  joinedLabel: string;
  lastActiveIso: string | null;
  lastActiveLabel: string;
  healthScore: number;
  vip: boolean;
  openTickets: number;
  anonymized: boolean;
}

export interface CustomerFilterState {
  q: string;
  stage: string;
  risk: string;
  plan: string;
  segment: string;
  sort: string;
}

export interface PlanOption {
  code: string;
  name: string;
}

const STAGE_OPTIONS = LIFECYCLE_STAGES.map((stage) => ({
  value: stage,
  label: stage === 'past_due' ? 'Past due' : stage[0].toUpperCase() + stage.slice(1),
}));

const RISK_OPTIONS = RISK_LEVELS.map((risk) => ({
  value: risk,
  label: risk === 'at_risk' ? 'At risk' : risk === 'critical' ? 'Critical' : 'Healthy',
}));

const SEGMENT_OPTIONS = [
  { value: 'self_serve', label: 'Self serve' },
  { value: 'smb', label: 'SMB' },
  { value: 'enterprise', label: 'Enterprise' },
];

const SORT_LABELS: Record<(typeof CUSTOMER_SORTS)[number], string> = {
  recent: 'Newest first',
  oldest: 'Oldest first',
  name: 'Name A–Z',
  mrr: 'Highest MRR',
  activity: 'Most recently active',
  health: 'Lowest health first',
};

const SORT_OPTIONS = CUSTOMER_SORTS.map((sort) => ({ value: sort, label: SORT_LABELS[sort] }));

export interface CustomerBrowserProps {
  rows: CustomerRowView[];
  filters: CustomerFilterState;
  plans: PlanOption[];
  page: number;
  pageCount: number;
  total: number;
  /** True when a risk filter hit the scan cap and the result may be partial. */
  truncated: boolean;
}

export function CustomerBrowser({
  rows,
  filters,
  plans,
  page,
  pageCount,
  total,
  truncated,
}: CustomerBrowserProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  /**
   * Push a filter change into the URL rather than into component state.
   *
   * The URL is the source of truth so a filtered view can be bookmarked, shared
   * in a ticket ("here are the accounts I mean"), and re-entered by the back
   * button. It also means the server does the filtering, which is the only way
   * a stage filter can be exact across a book larger than one page.
   */
  const apply = useCallback(
    (next: Record<string, string | null>) => {
      const search = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(next)) {
        if (value === null || value === '') search.delete(key);
        else search.set(key, value);
      }
      // Any change to the slice invalidates the position within it — page 4 of
      // a different filter is a different, usually empty, page.
      if (!('page' in next)) search.delete('page');
      const query = search.toString();
      startTransition(() => router.push(query ? `${pathname}?${query}` : pathname));
    },
    [params, pathname, router],
  );

  // Search hits the database, so it trails the keystrokes rather than firing on
  // each one. The input itself stays instant.
  const urlQuery = filters.q;
  const [query, setQuery] = useState(urlQuery);
  const debounced = useDebouncedValue(query, 350);

  useEffect(() => {
    if (debounced === urlQuery) return;
    apply({ q: debounced || null });
    // `apply` is stable per params object; re-running on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const dirty = Boolean(
    filters.q || filters.stage || filters.risk || filters.plan || filters.segment || filters.sort,
  );

  const columns: Column<CustomerRowView>[] = [
    {
      key: 'name',
      header: 'Customer',
      sortable: true,
      width: '22rem',
      searchText: (row) => `${row.name} ${row.email} ${row.location}`,
      render: (row) => (
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate font-semibold text-ink">
            {row.vip && (
              <Star
                className="h-3.5 w-3.5 shrink-0 fill-warn text-warn"
                aria-label="VIP account"
              />
            )}
            <span className="truncate">{row.name}</span>
            {row.anonymized && <Pill tone="neutral">Erased</Pill>}
          </p>
          <p className="truncate text-xs text-muted">{row.email}</p>
        </div>
      ),
    },
    {
      key: 'planLabel',
      header: 'Plan',
      sortable: true,
      hideBelow: 'md',
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate text-ink">{row.planLabel}</p>
          {row.intervalLabel && <p className="truncate text-xs text-faint">{row.intervalLabel}</p>}
        </div>
      ),
    },
    {
      key: 'view',
      header: 'Stage',
      sortable: true,
      render: (row) => (
        <div className="flex flex-col items-start gap-1">
          <StageBadge view={row.view} />
          {row.risk !== 'normal' && <RiskBadge risk={row.risk} />}
        </div>
      ),
    },
    {
      key: 'mrrCents',
      header: 'MRR',
      sortable: true,
      numeric: true,
      render: (row) =>
        row.mrrCents > 0 ? (
          <span className="font-semibold text-ink">{formatCents(row.mrrCents, row.currency)}</span>
        ) : (
          <span className="text-faint">—</span>
        ),
    },
    {
      key: 'applicationsUsed',
      header: 'Applications',
      sortable: true,
      hideBelow: 'lg',
      width: '10rem',
      sortValue: (row) =>
        row.applicationsLimit > 0 ? row.applicationsUsed / row.applicationsLimit : -1,
      render: (row) =>
        row.applicationsLimit > 0 ? (
          <div className="w-32">
            <Meter used={row.applicationsUsed} total={row.applicationsLimit} />
            <p className="mt-1 text-xs tabular-nums text-faint">
              {row.applicationsUsed}/{row.applicationsLimit} · {row.applicationsLast30Days} in 30d
            </p>
          </div>
        ) : (
          <span className="text-faint">No plan</span>
        ),
    },
    {
      key: 'healthScore',
      header: 'Health',
      sortable: true,
      numeric: true,
      hideBelow: 'lg',
      render: (row) => (
        <span
          title={row.riskSummary}
          className={cn(
            'font-semibold tabular-nums',
            row.healthScore >= 80
              ? 'text-success'
              : row.healthScore >= 50
                ? 'text-muted'
                : 'text-danger',
          )}
        >
          {row.healthScore}
        </span>
      ),
    },
    {
      key: 'openTickets',
      header: 'Tickets',
      sortable: true,
      numeric: true,
      hideBelow: 'lg',
      render: (row) =>
        row.openTickets > 0 ? (
          <Pill tone="caution">{row.openTickets}</Pill>
        ) : (
          <span className="text-faint">—</span>
        ),
    },
    {
      key: 'joinedIso',
      header: 'Joined',
      sortable: true,
      hideBelow: 'md',
      sortValue: (row) => row.joinedIso,
      render: (row) => <span className="whitespace-nowrap text-muted">{row.joinedLabel}</span>,
    },
    {
      key: 'lastActiveIso',
      header: 'Last active',
      sortable: true,
      sortValue: (row) => row.lastActiveIso,
      render: (row) => (
        <span
          className={cn(
            'whitespace-nowrap',
            row.lastActiveIso === null ? 'text-faint' : 'text-muted',
          )}
        >
          {row.lastActiveLabel}
        </span>
      ),
    },
  ];

  return (
    <>
      <FilterBar
        onReset={() =>
          apply({ q: null, stage: null, risk: null, plan: null, segment: null, sort: null })
        }
        canReset={dirty}
        actions={
          <ExportButton
            endpoint="/console/exports/customers"
            filename="jobpilot-customers"
            label="Export"
            params={{
              q: filters.q,
              stage: filters.stage,
              risk: filters.risk,
              plan: filters.plan,
              segment: filters.segment,
              sort: filters.sort,
            }}
          />
        }
        summary={
          <>
            {total.toLocaleString('en-CA')} customer{total === 1 ? '' : 's'} match this filter
            {pageCount > 1 && ` · page ${page} of ${pageCount}`}
            {' · column sorting reorders the loaded page; the “Order by” filter sorts the whole book.'}
          </>
        }
      >
        <SearchInput
          value={query}
          onChange={setQuery}
          label="Search customers"
          placeholder="Name, email or city"
          className="w-full sm:w-64"
        />
        <SelectFilter
          label="Stage"
          value={filters.stage}
          options={STAGE_OPTIONS}
          onChange={(value) => apply({ stage: value || null })}
          anyLabel="Any stage"
        />
        <SelectFilter
          label="Risk"
          value={filters.risk}
          options={RISK_OPTIONS}
          onChange={(value) => apply({ risk: value || null })}
          anyLabel="Any risk"
        />
        <SelectFilter
          label="Plan"
          value={filters.plan}
          options={plans.map((plan) => ({ value: plan.code, label: plan.name }))}
          onChange={(value) => apply({ plan: value || null })}
          anyLabel="Any plan"
        />
        <SelectFilter
          label="Segment"
          value={filters.segment}
          options={SEGMENT_OPTIONS}
          onChange={(value) => apply({ segment: value || null })}
          anyLabel="Any segment"
        />
        <SelectFilter
          label="Order by"
          value={filters.sort || 'recent'}
          options={SORT_OPTIONS}
          onChange={(value) => apply({ sort: value === 'recent' ? null : value })}
        />
      </FilterBar>

      {truncated && (
        <p
          role="status"
          className="mb-4 flex items-start gap-2 rounded-xl bg-warn/10 p-3 text-xs text-warn"
        >
          <TriangleAlert className="mt-px h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            Churn risk is computed per account rather than stored, so filtering by it scans a
            capped slice of the book. This result may be incomplete — narrow it with a plan, stage
            or date filter for an exact answer.
          </span>
        </p>
      )}

      <DataTable
        caption="Customers"
        rows={rows}
        columns={columns}
        rowKey={(row) => row.userId}
        loading={pending}
        dense
        onRowClick={(row) => router.push(`/console/customers/${row.userId}`)}
        empty={{
          icon: <Users className="h-5 w-5" aria-hidden="true" />,
          title: dirty ? 'No customers match these filters' : 'No customers yet',
          description: dirty
            ? 'Clear a filter or widen the search — the book is filtered server-side, so nothing is hidden on another page.'
            : 'Accounts appear here the moment somebody signs up.',
        }}
      />

      {pageCount > 1 && (
        <nav
          aria-label="Customer pages"
          className="mt-4 flex items-center justify-between gap-3 text-sm"
        >
          <button
            type="button"
            disabled={page <= 1 || pending}
            onClick={() => apply({ page: String(page - 1) })}
            className="btn-secondary px-3 py-2 text-xs disabled:opacity-40"
          >
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
            Previous
          </button>
          <span className="tabular-nums text-muted" aria-live="polite">
            Page {page} of {pageCount}
          </span>
          <button
            type="button"
            disabled={page >= pageCount || pending}
            onClick={() => apply({ page: String(page + 1) })}
            className="btn-secondary px-3 py-2 text-xs disabled:opacity-40"
          >
            Next
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </nav>
      )}

      <p className="mt-4 text-xs text-faint">
        Looking for one person?{' '}
        <Link href="/console/tickets" className="text-brand-500 hover:text-brand-600">
          The support queue
        </Link>{' '}
        links straight to the account behind each ticket.
      </p>
    </>
  );
}
