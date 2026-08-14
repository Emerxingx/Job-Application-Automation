'use client';

import Link from 'next/link';
import { Download, Receipt } from 'lucide-react';
import { DataTable, type Column } from '@/components/data-table';
import { EmptyState, cn } from '@/components/ui';

/**
 * One row of billing history, already formatted.
 *
 * Every display string is built on the server and passed through: dates, money
 * and periods all render identically on both sides of hydration that way, and
 * the client never has to know that money is stored in integer cents.
 */
export interface InvoiceRowView {
  id: string;
  number: string;
  /** ISO-8601, for sorting only. */
  issuedAtIso: string | null;
  issuedLabel: string;
  periodLabel: string;
  planLabel: string;
  totalLabel: string;
  totalCents: number;
  status: InvoiceRowStatus;
  /** Amount still owed, when there is one. */
  dueLabel: string | null;
  pdfUrl: string;
}

export type InvoiceRowStatus = 'paid' | 'open' | 'past_due' | 'void' | 'uncollectible';

const STATUS_STYLE: Record<InvoiceRowStatus, { label: string; className: string }> = {
  paid: { label: 'Paid', className: 'bg-success/10 text-success' },
  open: { label: 'Due', className: 'bg-brand-500/10 text-brand-600' },
  past_due: { label: 'Past due', className: 'bg-danger/10 text-danger' },
  void: { label: 'Voided', className: 'bg-raised text-faint' },
  uncollectible: { label: 'Written off', className: 'bg-warn/10 text-warn' },
};

/**
 * Invoice statuses are not in `StatusBadge`'s map in src/components/ui.tsx —
 * that map covers applications, agents and matches — so this pill mirrors its
 * shape rather than falling through to a toneless grey chip. On a billing page
 * "paid" being green and "past due" being red is the whole point of the column.
 */
function InvoiceStatusPill({ status }: { status: InvoiceRowStatus }) {
  const style = STATUS_STYLE[status];
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-lg px-2 py-0.5 text-xs font-semibold',
        style.className,
      )}
    >
      {style.label}
    </span>
  );
}

export function InvoiceTable({ rows }: { rows: InvoiceRowView[] }) {
  const columns: Column<InvoiceRowView>[] = [
    {
      key: 'number',
      header: 'Invoice',
      sortable: true,
      render: (row) => <span className="font-semibold text-ink">{row.number}</span>,
    },
    {
      key: 'issuedLabel',
      header: 'Issued',
      sortable: true,
      sortValue: (row) => row.issuedAtIso,
      render: (row) => <span className="whitespace-nowrap">{row.issuedLabel}</span>,
    },
    {
      key: 'periodLabel',
      header: 'Billing period',
      hideBelow: 'md',
      render: (row) => <span className="text-muted">{row.periodLabel}</span>,
    },
    {
      key: 'planLabel',
      header: 'Plan',
      hideBelow: 'lg',
      sortable: true,
      render: (row) => <span className="text-muted">{row.planLabel}</span>,
    },
    {
      key: 'totalCents',
      header: 'Amount',
      numeric: true,
      sortable: true,
      searchText: (row) => row.totalLabel,
      render: (row) => (
        <span className="whitespace-nowrap font-semibold text-ink">{row.totalLabel}</span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      searchText: (row) => STATUS_STYLE[row.status].label,
      render: (row) => (
        <span className="flex flex-col items-start gap-1">
          <InvoiceStatusPill status={row.status} />
          {row.dueLabel && (
            <span className="text-xs text-muted">{row.dueLabel} outstanding</span>
          )}
        </span>
      ),
    },
    {
      key: 'pdf',
      // A visible header rather than `headerSrOnly`. Tailwind's `.sr-only` is
      // `position: absolute`, and an absolutely positioned span in the last
      // column escapes the table's horizontal scroll container and widens the
      // page body itself — measured at 390px, the document grew by 33px.
      header: 'PDF',
      align: 'right',
      width: '6rem',
      searchText: () => '',
      render: (row) => (
        <a
          href={row.pdfUrl}
          className="btn-secondary px-2.5 py-1.5 text-xs"
          aria-label={`Download invoice ${row.number} as PDF`}
        >
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
          PDF
        </a>
      ),
    },
  ];

  // The table's own empty state lives inside a horizontally scrolling
  // container, so on a 390px screen its prose is clipped by a table that is
  // wider than the viewport. With no rows there is nothing to scroll to, so
  // the shared EmptyState — the same one the rest of the dashboard uses —
  // renders instead.
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Receipt className="h-5 w-5" />}
        title="No invoices yet"
        description="Invoices appear here the moment your first billing period closes. Nothing is charged until you choose a paid plan."
        action={
          <Link href="/dashboard/billing" className="btn-primary">
            View plans
          </Link>
        }
      />
    );
  }

  return (
    <div className="card overflow-hidden">
      <DataTable
        caption="Invoices"
        rows={rows}
        columns={columns}
        rowKey={(row) => row.id}
        searchable={rows.length > 8}
        searchPlaceholder="Invoice number, plan or amount"
        pageSize={20}
        initialSort={{ key: 'issuedLabel', direction: 'desc' }}
        empty={{
          icon: <Receipt className="h-5 w-5" aria-hidden="true" />,
          title: 'No matching invoices',
          description: 'Nothing in your billing history matches that search.',
        }}
      />
    </div>
  );
}
