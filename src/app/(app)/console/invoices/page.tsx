import { AlertTriangle, FileClock, Receipt, Wallet } from 'lucide-react';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { formatPeriod, intervalLabel } from '@/lib/billing/invoice';
import { PageHeader } from '@/components/ui';
import { consoleGate } from '../guard';
import { AccessDenied, Kpi, count, day, money } from '../ui';
import { InvoiceConsole, type InvoiceRowView } from './invoice-console';

export const metadata = { title: 'Invoices' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;
const RECENT_DAYS = 30;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function one(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

const STATUSES = ['draft', 'open', 'paid', 'void', 'uncollectible'];
const CURRENCIES = ['CAD', 'USD'];

/**
 * Money across currencies, printed side by side.
 *
 * There is no FX source in this codebase, so CAD cents and USD cents are
 * different units and adding them produces a number that is wrong in both. The
 * tile shows each currency instead of a total — see the same decision in
 * lib/analytics/revenue.ts.
 */
function multiCurrency(groups: { currency: string; cents: number }[]): string {
  const nonZero = groups.filter((group) => group.cents !== 0);
  if (nonZero.length === 0) return money(0);
  return nonZero
    .sort((a, b) => b.cents - a.cents)
    .map((group) => money(group.cents, group.currency))
    .join(' · ');
}

export default async function ConsoleInvoicesPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  // Invoices are the money documents and this page can settle one by hand, so
  // it sits above plain support access.
  const gate = await consoleGate('billing_ops');
  if (!gate.ok) return <AccessDenied />;

  const params = await searchParams;
  const q = one(params.q).trim();
  const statusParam = one(params.status);
  const currencyParam = one(params.currency).toUpperCase();
  const overdue = one(params.overdue) === '1' ? '1' : '';
  const pageParam = Number.parseInt(one(params.page), 10);
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;

  const status = STATUSES.includes(statusParam) ? statusParam : '';
  const currency = CURRENCIES.includes(currencyParam) ? currencyParam : '';

  const now = new Date();
  const recentSince = new Date(now.getTime() - RECENT_DAYS * 86_400_000);

  const and: Prisma.InvoiceWhereInput[] = [];
  if (status) and.push({ status });
  if (currency) and.push({ currency });
  // "Past due" is not a stored status — it is an open invoice whose due date
  // has passed, which is the queue collections actually works.
  if (overdue) and.push({ status: 'open', dueAt: { lt: now } });
  if (q) {
    // SQLite's LIKE is case-insensitive for ASCII, which is why there is no
    // `mode: 'insensitive'` here — the SQLite connector does not emit it.
    and.push({
      OR: [
        { number: { contains: q } },
        { user: { email: { contains: q } } },
        { user: { fullName: { contains: q } } },
      ],
    });
  }
  const where: Prisma.InvoiceWhereInput = and.length > 0 ? { AND: and } : {};

  const [total, invoices, openByCurrency, collectedByCurrency, overdueCount, draftCount] =
    await Promise.all([
      db.invoice.count({ where }),
      db.invoice.findMany({
        where,
        // Drafts carry no issue date; SQLite sorts NULLs last on DESC, so they
        // fall to the bottom rather than crowding the top of the queue.
        orderBy: [{ issuedAt: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: {
          id: true,
          number: true,
          status: true,
          currency: true,
          planName: true,
          interval: true,
          subtotalCents: true,
          discountCents: true,
          taxCents: true,
          totalCents: true,
          amountPaidCents: true,
          amountCreditedCents: true,
          amountRefundedCents: true,
          amountDueCents: true,
          periodStart: true,
          periodEnd: true,
          issuedAt: true,
          dueAt: true,
          paidAt: true,
          createdAt: true,
          provider: true,
          dunningStage: true,
          attemptCount: true,
          user: { select: { id: true, fullName: true, email: true } },
        },
      }),
      db.invoice.groupBy({
        by: ['currency'],
        where: { status: 'open' },
        _sum: { amountDueCents: true },
        _count: { _all: true },
      }),
      db.invoice.groupBy({
        by: ['currency'],
        where: { status: 'paid', paidAt: { gte: recentSince } },
        _sum: { totalCents: true },
      }),
      db.invoice.count({ where: { status: 'open', dueAt: { lt: now } } }),
      db.invoice.count({ where: { status: 'draft' } }),
    ]);

  const openCount = openByCurrency.reduce((sum, group) => sum + group._count._all, 0);

  const rows: InvoiceRowView[] = invoices.map((invoice) => {
    const pastDue =
      invoice.status === 'open' && invoice.dueAt !== null && invoice.dueAt.getTime() < now.getTime();

    return {
      id: invoice.id,
      numberLabel: invoice.number ?? `Draft ${invoice.id.slice(-6)}`,
      displayStatus: pastDue ? 'past_due' : invoice.status,
      rawStatus: invoice.status,
      customerId: invoice.user.id,
      customerName: invoice.user.fullName || invoice.user.email,
      customerEmail: invoice.user.email,
      planLabel: invoice.planName
        ? `${invoice.planName} · ${intervalLabel(invoice.interval)}`
        : '—',
      currency: invoice.currency,
      subtotalCents: invoice.subtotalCents,
      discountCents: invoice.discountCents,
      taxCents: invoice.taxCents,
      totalCents: invoice.totalCents,
      amountPaidCents: invoice.amountPaidCents,
      amountCreditedCents: invoice.amountCreditedCents,
      amountRefundedCents: invoice.amountRefundedCents,
      amountDueCents: invoice.amountDueCents,
      issuedIso: invoice.issuedAt ? invoice.issuedAt.toISOString() : null,
      issuedLabel: invoice.issuedAt ? day(invoice.issuedAt) : 'Not issued',
      dueIso: invoice.dueAt ? invoice.dueAt.toISOString() : null,
      dueLabel: invoice.dueAt ? day(invoice.dueAt) : '—',
      paidLabel: invoice.paidAt ? day(invoice.paidAt) : '—',
      periodLabel:
        invoice.periodStart && invoice.periodEnd
          ? formatPeriod(invoice.periodStart, invoice.periodEnd)
          : '—',
      provider: invoice.provider ?? 'not set',
      dunningStage: invoice.dunningStage,
      attemptCount: invoice.attemptCount,
      // `markInvoicePaid` accepts open and uncollectible (a recovered write-off)
      // and refuses drafts and voids. Mirroring that here keeps the button from
      // being offered for an action the ledger will reject.
      canMarkPaid:
        (invoice.status === 'open' || invoice.status === 'uncollectible') &&
        invoice.amountDueCents > 0,
      hasPdf: invoice.number !== null,
    };
  });

  return (
    <>
      <PageHeader
        title="Invoices"
        description="Every document across every customer. Currencies are reported side by side and never summed — there is no exchange rate in this system."
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label="Outstanding"
          value={multiCurrency(
            openByCurrency.map((group) => ({
              currency: group.currency,
              cents: group._sum.amountDueCents ?? 0,
            })),
          )}
          tone={openCount > 0 ? 'caution' : 'positive'}
          icon={Wallet}
          hint={`${count(openCount)} open invoice${openCount === 1 ? '' : 's'}`}
        />
        <Kpi
          label="Past due"
          value={count(overdueCount)}
          tone={overdueCount > 0 ? 'critical' : 'positive'}
          icon={AlertTriangle}
          href="/console/invoices?overdue=1"
          hint={
            overdueCount > 0
              ? 'Open invoices whose due date has passed — the collections queue.'
              : 'Nothing has slipped past its due date.'
          }
        />
        <Kpi
          label={`Collected · ${RECENT_DAYS}d`}
          value={multiCurrency(
            collectedByCurrency.map((group) => ({
              currency: group.currency,
              cents: group._sum.totalCents ?? 0,
            })),
          )}
          tone="positive"
          icon={Receipt}
          hint="Invoices that reached paid in the window, at their document total."
        />
        <Kpi
          label="Drafts"
          value={count(draftCount)}
          icon={FileClock}
          href="/console/invoices?status=draft"
          hint="Unissued and unnumbered. A discarded draft burns no number from the sequence."
        />
      </div>

      <InvoiceConsole
        rows={rows}
        filters={{ q, status, currency, overdue }}
        page={page}
        pageCount={Math.max(1, Math.ceil(total / PAGE_SIZE))}
        total={total}
        canSettle
      />
    </>
  );
}
