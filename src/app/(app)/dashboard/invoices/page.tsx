import Link from 'next/link';
import { CalendarClock, CreditCard, Receipt } from 'lucide-react';
import { requireTenant } from '@/lib/tenancy/request';
import {
  formatCents,
  formatPeriod,
  intervalLabel,
  invoiceBalance,
  listInvoicesForUser,
} from '@/lib/billing/invoice';
import { priceFor } from '@/lib/subscription';
import type { BillingInterval } from '@/lib/types';
import { Card, PageHeader } from '@/components/ui';
import { ExportButton } from '@/components/export-button';
import { InvoiceTable, type InvoiceRowStatus, type InvoiceRowView } from './invoice-table';

export const metadata = { title: 'Invoices' };
export const dynamic = 'force-dynamic';

/** How many documents the table holds. Older ones are still in the CSV export. */
const PAGE_LIMIT = 100;

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
}

function toInterval(value: string): BillingInterval {
  return value === 'annual' || value === 'quarterly' ? value : 'monthly';
}

/**
 * The pill a row shows.
 *
 * `open` splits into "Due" and "Past due" on the due date, because those are
 * two different pieces of news and the raw status column cannot tell them
 * apart. Everything else maps straight through.
 */
function rowStatus(invoice: {
  status: string;
  dueAt: Date | null;
  totalCents: number;
  amountPaidCents: number;
  amountCreditedCents: number;
}): InvoiceRowStatus {
  if (invoice.status === 'void') return 'void';
  if (invoice.status === 'uncollectible') return 'uncollectible';
  if (invoice.status === 'paid' || invoiceBalance(invoice).settled) return 'paid';
  if (invoice.dueAt && invoice.dueAt.getTime() < Date.now()) return 'past_due';
  return 'open';
}

export default async function InvoicesPage() {
  const { user, run } = await requireTenant();

  const [invoices, [spendByCurrency, subscription]] = await Promise.all([
    listInvoicesForUser(user.id, { limit: PAGE_LIMIT }),
    run((tx) =>
      Promise.all([
        // Lifetime spend is money that actually moved, so it reads the payment and
        // refund caches rather than the invoiced total — a voided or credited
        // invoice was never a cost to this customer.
        tx.invoice.groupBy({
          by: ['currency'],
          where: { userId: user.id, number: { not: null } },
          _sum: { amountPaidCents: true, amountRefundedCents: true },
          _count: { _all: true },
        }),
        tx.subscription.findUnique({ where: { userId: user.id }, include: { plan: true } }),
      ]),
    ),
  ]);

  const rows: InvoiceRowView[] = invoices.map((invoice) => {
    const balance = invoiceBalance(invoice);
    const status = rowStatus(invoice);
    const issuedAt = invoice.issuedAt ?? invoice.createdAt;

    return {
      id: invoice.id,
      // `listInvoicesForUser` filters to issued documents, so a number always
      // exists; the fallback keeps the type honest rather than asserting.
      number: invoice.number ?? `Draft ${invoice.id.slice(-6)}`,
      issuedAtIso: issuedAt.toISOString(),
      issuedLabel: formatDate(issuedAt),
      periodLabel:
        invoice.periodStart && invoice.periodEnd
          ? formatPeriod(invoice.periodStart, invoice.periodEnd)
          : '—',
      planLabel: invoice.planName
        ? `${invoice.planName} · ${intervalLabel(invoice.interval)}`
        : '—',
      totalLabel: formatCents(invoice.totalCents, invoice.currency),
      totalCents: invoice.totalCents,
      status,
      dueLabel:
        balance.dueCents > 0 && status !== 'void'
          ? formatCents(balance.dueCents, invoice.currency)
          : null,
      pdfUrl: `/api/invoices/${invoice.id}/pdf`,
    };
  });

  const spend = spendByCurrency
    .map((group) => ({
      currency: group.currency,
      netCents: (group._sum.amountPaidCents ?? 0) - (group._sum.amountRefundedCents ?? 0),
      refundedCents: group._sum.amountRefundedCents ?? 0,
      count: group._count._all,
    }))
    .filter((group) => group.count > 0)
    .sort((a, b) => b.netCents - a.netCents);

  const documentCount = spend.reduce((sum, group) => sum + group.count, 0);
  const refundedTotal = spend.reduce((sum, group) => sum + group.refundedCents, 0);
  const outstanding = rows.filter((row) => row.status === 'open' || row.status === 'past_due');

  const plan = subscription?.plan;
  const renewalCents = plan ? priceFor(plan, toInterval(subscription.interval)) : null;
  const canceling = subscription?.status === 'canceled' || subscription?.cancelAtPeriodEnd;

  return (
    <>
      <PageHeader
        title="Invoices"
        description="Every invoice JobPilot has issued to you, with the PDF your accountant needs."
        action={
          <ExportButton
            endpoint="/api/exports/invoices"
            filename="jobpilot-invoices"
            label="Export all"
          />
        }
      />

      {/* Summary */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-faint">Lifetime spend</p>
          {spend.length === 0 ? (
            <>
              <p className="mt-1.5 text-2xl font-bold tabular-nums text-ink">
                {formatCents(0)}
              </p>
              <p className="mt-1 text-xs text-muted">Nothing has been charged yet.</p>
            </>
          ) : (
            <>
              <p className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                {spend.map((group) => (
                  <span
                    key={group.currency}
                    className="text-2xl font-bold tabular-nums text-ink"
                  >
                    {formatCents(group.netCents, group.currency)}
                  </span>
                ))}
              </p>
              {/* A count of documents, phrased so it does not read as a claim
                  that every one of them was paid — an open invoice is issued
                  but has contributed nothing to the figure above. */}
              <p className="mt-1 text-xs text-muted">
                {documentCount} invoice{documentCount === 1 ? '' : 's'} issued
                {refundedTotal > 0 && `, net of ${formatCents(refundedTotal)} refunded`}
              </p>
            </>
          )}
        </Card>

        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-faint">Outstanding</p>
          <p
            className={`mt-1.5 text-2xl font-bold tabular-nums ${
              outstanding.length > 0 ? 'text-warn' : 'text-ink'
            }`}
          >
            {outstanding.length}
          </p>
          <p className="mt-1 text-xs text-muted">
            {outstanding.length === 0
              ? 'Everything is settled.'
              : `${outstanding.length === 1 ? 'Invoice' : 'Invoices'} awaiting payment — open the PDF for the payment details.`}
          </p>
        </Card>

        <Card className="p-4">
          <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-faint">
            <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
            Next renewal
          </p>
          {subscription && plan && !canceling ? (
            <>
              <p className="mt-1.5 text-2xl font-bold tabular-nums text-ink">
                {renewalCents === null ? '—' : formatCents(renewalCents, subscription.currency)}
              </p>
              <p className="mt-1 text-xs text-muted">
                {plan.name} · billed {intervalLabel(subscription.interval)} · renews{' '}
                {formatDate(subscription.renewsAt)}
              </p>
            </>
          ) : (
            <>
              <p className="mt-1.5 text-2xl font-bold text-ink">—</p>
              <p className="mt-1 text-xs text-muted">
                {canceling
                  ? 'Your subscription will not renew.'
                  : 'No active subscription.'}{' '}
                <Link
                  href="/dashboard/billing"
                  className="font-medium text-brand-500 hover:text-brand-600"
                >
                  {canceling ? 'Reactivate' : 'Choose a plan'}
                </Link>
              </p>
            </>
          )}
        </Card>
      </div>

      {/* History */}
      <section aria-labelledby="invoice-history">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 id="invoice-history" className="text-lg font-semibold text-ink">
            Billing history
          </h2>
          <Link
            href="/dashboard/billing"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-500 hover:text-brand-600"
          >
            <CreditCard className="h-4 w-4" aria-hidden="true" />
            Manage plan
          </Link>
        </div>

        <InvoiceTable rows={rows} />

        {invoices.length >= PAGE_LIMIT && (
          <p className="mt-3 flex items-center gap-1.5 text-xs text-muted">
            <Receipt className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            Showing your {PAGE_LIMIT} most recent invoices. Use “Export all” for the complete
            history.
          </p>
        )}
      </section>
    </>
  );
}
