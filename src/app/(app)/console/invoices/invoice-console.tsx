'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Receipt,
  User,
} from 'lucide-react';
import { DataTable, formatCents, type Column } from '@/components/data-table';
import { Drawer } from '@/components/drawer';
import { ExportButton } from '@/components/export-button';
import { FilterBar, SearchInput, SelectFilter, useDebouncedValue } from '@/components/filters';
import { cn } from '@/components/ui';
import { Field, FieldGrid, InvoiceBadge, Pill } from '../ui';
import { markInvoicePaidAction } from './actions';

/** Every string is formatted on the server; the client only lays it out. */
export interface InvoiceRowView {
  id: string;
  numberLabel: string;
  /** `draft | open | past_due | paid | void | uncollectible` — `past_due` is derived. */
  displayStatus: string;
  rawStatus: string;
  customerId: string;
  customerName: string;
  customerEmail: string;
  planLabel: string;
  currency: string;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  amountPaidCents: number;
  amountCreditedCents: number;
  amountRefundedCents: number;
  amountDueCents: number;
  issuedIso: string | null;
  issuedLabel: string;
  dueIso: string | null;
  dueLabel: string;
  paidLabel: string;
  periodLabel: string;
  provider: string;
  dunningStage: string;
  attemptCount: number;
  /** False for drafts, voids and anything already settled. */
  canMarkPaid: boolean;
  /** Only an issued document has a PDF. */
  hasPdf: boolean;
}

export interface InvoiceFilterState {
  q: string;
  status: string;
  currency: string;
  overdue: string;
}

const STATUS_OPTIONS = [
  { value: 'draft', label: 'Draft' },
  { value: 'open', label: 'Open' },
  { value: 'paid', label: 'Paid' },
  { value: 'void', label: 'Void' },
  { value: 'uncollectible', label: 'Written off' },
];

const CURRENCY_OPTIONS = [
  { value: 'CAD', label: 'CAD' },
  { value: 'USD', label: 'USD' },
];

const OVERDUE_OPTIONS = [{ value: '1', label: 'Past due only' }];

export interface InvoiceConsoleProps {
  rows: InvoiceRowView[];
  filters: InvoiceFilterState;
  page: number;
  pageCount: number;
  total: number;
  /** Whether this staff member may settle an invoice by hand. */
  canSettle: boolean;
}

export function InvoiceConsole({
  rows,
  filters,
  page,
  pageCount,
  total,
  canSettle,
}: InvoiceConsoleProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<InvoiceRowView | null>(null);

  const apply = useCallback(
    (next: Record<string, string | null>) => {
      const search = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(next)) {
        if (value === null || value === '') search.delete(key);
        else search.set(key, value);
      }
      if (!('page' in next)) search.delete('page');
      const query = search.toString();
      startTransition(() => router.push(query ? `${pathname}?${query}` : pathname));
    },
    [params, pathname, router],
  );

  const urlQuery = filters.q;
  const [query, setQuery] = useState(urlQuery);
  const debounced = useDebouncedValue(query, 350);

  useEffect(() => {
    if (debounced === urlQuery) return;
    apply({ q: debounced || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const dirty = Boolean(filters.q || filters.status || filters.currency || filters.overdue);

  const columns: Column<InvoiceRowView>[] = [
    {
      key: 'numberLabel',
      header: 'Invoice',
      sortable: true,
      render: (row) => (
        <span className={cn('font-semibold', row.rawStatus === 'draft' ? 'text-faint' : 'text-ink')}>
          {row.numberLabel}
        </span>
      ),
    },
    {
      key: 'customerName',
      header: 'Customer',
      sortable: true,
      width: '18rem',
      searchText: (row) => `${row.customerName} ${row.customerEmail}`,
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate text-ink">{row.customerName}</p>
          <p className="truncate text-xs text-muted">{row.customerEmail}</p>
        </div>
      ),
    },
    {
      key: 'displayStatus',
      header: 'Status',
      sortable: true,
      render: (row) => (
        <div className="flex flex-col items-start gap-1">
          <InvoiceBadge status={row.displayStatus} />
          {row.dunningStage !== 'none' && row.dunningStage !== 'recovered' && (
            <Pill tone="caution">
              dunning: {row.dunningStage} ({row.attemptCount})
            </Pill>
          )}
        </div>
      ),
    },
    {
      key: 'planLabel',
      header: 'Plan',
      hideBelow: 'lg',
      render: (row) => <span className="text-muted">{row.planLabel}</span>,
    },
    {
      key: 'totalCents',
      header: 'Total',
      sortable: true,
      numeric: true,
      render: (row) => <span className="text-ink">{formatCents(row.totalCents, row.currency)}</span>,
    },
    {
      key: 'amountDueCents',
      header: 'Outstanding',
      sortable: true,
      numeric: true,
      render: (row) =>
        row.amountDueCents > 0 ? (
          <span
            className={cn(
              'font-semibold',
              row.displayStatus === 'past_due' ? 'text-danger' : 'text-ink',
            )}
          >
            {formatCents(row.amountDueCents, row.currency)}
          </span>
        ) : (
          <span className="text-faint">—</span>
        ),
    },
    {
      key: 'issuedIso',
      header: 'Issued',
      sortable: true,
      hideBelow: 'md',
      sortValue: (row) => row.issuedIso,
      render: (row) => <span className="whitespace-nowrap text-muted">{row.issuedLabel}</span>,
    },
    {
      key: 'dueIso',
      header: 'Due',
      sortable: true,
      hideBelow: 'md',
      sortValue: (row) => row.dueIso,
      render: (row) => (
        <span
          className={cn(
            'whitespace-nowrap',
            row.displayStatus === 'past_due' ? 'font-semibold text-danger' : 'text-muted',
          )}
        >
          {row.dueLabel}
        </span>
      ),
    },
  ];

  return (
    <>
      <FilterBar
        onReset={() => apply({ q: null, status: null, currency: null, overdue: null })}
        canReset={dirty}
        actions={
          <ExportButton
            endpoint="/console/exports/invoices"
            filename="jobpilot-invoices"
            label="Export"
            params={{
              q: filters.q,
              status: filters.status,
              currency: filters.currency,
              overdue: filters.overdue,
            }}
          />
        }
        summary={
          <>
            {total.toLocaleString('en-CA')} invoice{total === 1 ? '' : 's'} match this filter
            {pageCount > 1 && ` · page ${page} of ${pageCount}`} · open a row for the breakdown, the
            PDF and manual settlement.
          </>
        }
      >
        <SearchInput
          value={query}
          onChange={setQuery}
          label="Search invoices"
          placeholder="Invoice number or customer email"
          className="w-full sm:w-72"
        />
        <SelectFilter
          label="Status"
          value={filters.status}
          options={STATUS_OPTIONS}
          onChange={(value) => apply({ status: value || null })}
          anyLabel="Any status"
        />
        <SelectFilter
          label="Currency"
          value={filters.currency}
          options={CURRENCY_OPTIONS}
          onChange={(value) => apply({ currency: value || null })}
          anyLabel="Any currency"
        />
        <SelectFilter
          label="Collection"
          value={filters.overdue}
          options={OVERDUE_OPTIONS}
          onChange={(value) => apply({ overdue: value || null })}
          anyLabel="Everything"
        />
      </FilterBar>

      <DataTable
        caption="Invoices"
        rows={rows}
        columns={columns}
        rowKey={(row) => row.id}
        loading={pending}
        dense
        onRowClick={setSelected}
        isRowActive={(row) => row.id === selected?.id}
        empty={{
          icon: <Receipt className="h-5 w-5" aria-hidden="true" />,
          title: dirty ? 'No invoices match these filters' : 'No invoices yet',
          description: dirty
            ? 'Filtering happens on the server, so nothing is hiding on another page. Try clearing a filter.'
            : 'Invoices appear here as soon as the first subscription is billed.',
        }}
      />

      {pageCount > 1 && (
        <nav
          aria-label="Invoice pages"
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

      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected ? selected.numberLabel : 'Invoice'}
        description={selected ? `${selected.customerName} · ${selected.customerEmail}` : undefined}
        width="lg"
        headerAction={selected ? <InvoiceBadge status={selected.displayStatus} /> : undefined}
      >
        {selected && (
          <InvoiceDetail
            invoice={selected}
            canSettle={canSettle}
            onSettled={() => {
              setSelected(null);
              startTransition(() => router.refresh());
            }}
          />
        )}
      </Drawer>
    </>
  );
}

/** The drawer body: the money, the provenance, and the one action. */
function InvoiceDetail({
  invoice,
  canSettle,
  onSettled,
}: {
  invoice: InvoiceRowView;
  canSettle: boolean;
  onSettled: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const cents = (value: number) => formatCents(value, invoice.currency);

  async function settle() {
    if (busy) return;
    setBusy(true);
    setResult(null);
    try {
      const outcome = await markInvoicePaidAction({ invoiceId: invoice.id, reason });
      setResult(outcome);
      if (outcome.ok) {
        setReason('');
        // Give the reader a beat to see the confirmation before the drawer
        // closes and the table behind it re-queries.
        setTimeout(onSettled, 900);
      }
    } catch {
      setResult({ ok: false, message: 'Could not reach the server. Nothing was changed.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <FieldGrid>
        <Field label="Customer">
          <Link
            href={`/console/customers/${invoice.customerId}`}
            className="inline-flex items-center gap-1 text-brand-500 hover:text-brand-600"
          >
            <User className="h-3.5 w-3.5" aria-hidden="true" />
            {invoice.customerName}
          </Link>
        </Field>
        <Field label="Plan">{invoice.planLabel}</Field>
        <Field label="Service period">{invoice.periodLabel}</Field>
        <Field label="Issued">{invoice.issuedLabel}</Field>
        <Field label="Due">{invoice.dueLabel}</Field>
        <Field label="Paid">{invoice.paidLabel}</Field>
        <Field label="Collection provider">{invoice.provider}</Field>
        <Field label="Dunning">
          {invoice.dunningStage === 'none'
            ? 'Not in dunning'
            : `${invoice.dunningStage} · ${invoice.attemptCount} attempt${invoice.attemptCount === 1 ? '' : 's'}`}
        </Field>
      </FieldGrid>

      <section aria-labelledby="invoice-totals">
        <h3 id="invoice-totals" className="mb-2 text-sm font-semibold text-ink">
          Totals
        </h3>
        <dl className="divide-y divide-line rounded-xl border border-line">
          <Row label="Subtotal" value={cents(invoice.subtotalCents)} />
          {invoice.discountCents > 0 && (
            <Row label="Discount" value={`−${cents(invoice.discountCents)}`} />
          )}
          <Row label="Tax" value={cents(invoice.taxCents)} />
          <Row label="Total" value={cents(invoice.totalCents)} strong />
          <Row label="Paid" value={cents(invoice.amountPaidCents)} />
          {invoice.amountCreditedCents > 0 && (
            <Row label="Credited" value={cents(invoice.amountCreditedCents)} />
          )}
          {invoice.amountRefundedCents > 0 && (
            <Row label="Refunded" value={cents(invoice.amountRefundedCents)} />
          )}
          <Row
            label="Outstanding"
            value={cents(invoice.amountDueCents)}
            strong
            tone={invoice.amountDueCents > 0 ? 'danger' : 'success'}
          />
        </dl>
        <p className="mt-2 text-xs text-faint">
          Total = subtotal − discount + tax. Outstanding = total − paid − credited, floored at zero;
          an overpayment lands on the credit ledger rather than as a negative receivable.
        </p>
      </section>

      <div className="flex flex-wrap gap-2">
        {invoice.hasPdf ? (
          <a href={`/console/invoices/${invoice.id}/pdf`} className="btn-secondary px-3 py-2 text-xs">
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            Download PDF
          </a>
        ) : (
          <p className="text-xs text-faint">
            This document has not been issued, so it has no number and no PDF.
          </p>
        )}
        <Link
          href={`/console/customers/${invoice.customerId}`}
          className="btn-ghost px-3 py-2 text-xs"
        >
          Open customer record
        </Link>
      </div>

      {/* --- Manual settlement --- */}
      {canSettle && invoice.canMarkPaid && (
        <section aria-labelledby="settle" className="rounded-xl border border-warn/40 bg-warn/5 p-4">
          <h3 id="settle" className="text-sm font-semibold text-ink">
            Mark as paid by hand
          </h3>
          <p className="mt-1 text-xs text-muted">
            Records a manual payment of {cents(invoice.amountDueCents)} against this invoice and
            settles it. Use this for money that arrived outside the gateway — a bank transfer, a
            cheque, a negotiated write-down already agreed. It does not charge anybody.
          </p>

          <label htmlFor="settle-reason" className="label mt-3 text-xs">
            Why (recorded in the audit log)
          </label>
          <textarea
            id="settle-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={2}
            maxLength={500}
            disabled={busy}
            placeholder="e-transfer ref 88213, confirmed with the customer on TKT-2026-000412"
            className="input resize-y text-sm disabled:opacity-60"
          />

          <button
            type="button"
            onClick={() => void settle()}
            disabled={busy || reason.trim().length < 12}
            className="btn-primary mt-3 px-3 py-2 text-xs"
          >
            {busy && (
              <Loader2
                className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            )}
            {busy ? 'Settling…' : `Settle ${cents(invoice.amountDueCents)}`}
          </button>
        </section>
      )}

      {!invoice.canMarkPaid && invoice.rawStatus !== 'paid' && (
        <p className="text-xs text-muted">
          {invoice.rawStatus === 'draft'
            ? 'A draft has no number yet. Issue it before a payment can settle against a numbered document.'
            : invoice.rawStatus === 'void'
              ? 'A voided invoice is not a receivable and cannot be paid. Raise a new one instead.'
              : 'Nothing is outstanding on this invoice.'}
        </p>
      )}

      {result && (
        <p
          role="status"
          className={cn(
            'flex items-start gap-1.5 rounded-xl p-2.5 text-xs',
            result.ok ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger',
          )}
        >
          {result.ok ? (
            <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          ) : (
            <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          )}
          {result.message}
        </p>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  strong,
  tone,
}: {
  label: string;
  value: string;
  strong?: boolean;
  tone?: 'danger' | 'success';
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-3 py-2 text-sm">
      <dt className={cn('text-muted', strong && 'font-semibold text-ink')}>{label}</dt>
      <dd
        className={cn(
          'tabular-nums text-ink',
          strong && 'font-semibold',
          tone === 'danger' && 'text-danger',
          tone === 'success' && 'text-success',
        )}
      >
        {value}
      </dd>
    </div>
  );
}
