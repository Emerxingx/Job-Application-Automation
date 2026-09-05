import Link from 'next/link';
import {
  AlertTriangle,
  ArrowRight,
  CreditCard,
  LifeBuoy,
  TrendingUp,
  UserPlus,
  Users,
} from 'lucide-react';
import { loadRevenueSummaryFromMarts } from '@/lib/analytics/finance/summary';
import { readDailyMetric, readLatestSnapshot } from '@/lib/analytics/platform/rollup';
import { describeFreshness, martFreshness } from '@/lib/analytics/freshness';
import { addUtcDays, foldIntoBuckets, rangeOfDays, seriesBase } from '@/lib/analytics/time';
import { loadFailedPaymentsQueue, loadRecentSignups } from './queues';
import { STAFF_RANK } from '@/lib/crm/auth';
import { Card, PageHeader } from '@/components/ui';
import { consoleGate } from './guard';
import { AccessDenied, Blank, Kpi, Pill, Section, compactMoney, count, money, percent, since } from './ui';
import { OverviewCharts, type RevenuePoint, type SignupPoint } from './overview-charts';

export const metadata = { title: 'Overview' };
export const dynamic = 'force-dynamic';

/** The window every number on this page is measured over. */
const WINDOW_DAYS = 30;

/** How many rows each attention list shows before it points at its full page. */
const LIST_SIZE = 7;

export default async function ConsoleOverviewPage() {
  // The layout has already gated this section. Checking again here is the rule
  // for every console page: layouts do not re-run on client-side navigation
  // within a segment, and this page reads the whole customer book.
  const gate = await consoleGate('support');
  if (!gate.ok) return <AccessDenied />;

  // The revenue and invoice pages require billing_ops. Every cross-link to them
  // is gated on the same rung, so a support agent is never shown a door that
  // will be shut in their face — an offered link that answers "restricted" is
  // worse than no link at all.
  const canBill = STAFF_RANK[gate.staff.role] >= STAFF_RANK.billing_ops;

  const now = new Date();
  const window = rangeOfDays(WINDOW_DAYS, now);
  const previous = { start: addUtcDays(window.start, -WINDOW_DAYS), end: window.start };

  // Stage 21 (ADR-0036): every NUMBER on this page is a mart row - the
  // revenue summary from DailyRevenueRollup, the counts from DailyMetric, the
  // point-in-time figures from the last snapshot the rollup wrote. The two
  // lists at the bottom are operational queues, read live and bounded, from
  // the one module allowed to do that (queues.ts). A static test holds the line.
  const [summary, signupsNowSeries, signupsPrevSeries, failedSeries, overdueSnap, overdueCentsSnap, ticketsSnap, breachedSnap, failedPayments, recentSignups, freshness] = await Promise.all([
    loadRevenueSummaryFromMarts({ range: window, granularity: 'day', currency: 'CAD' }),
    readDailyMetric('signups', window),
    readDailyMetric('signups', previous),
    readDailyMetric('failed_payments', window),
    readLatestSnapshot('overdue_invoices'),
    readLatestSnapshot('overdue_invoice_cents'),
    readLatestSnapshot('open_tickets'),
    readLatestSnapshot('breached_tickets'),
    loadFailedPaymentsQueue(window, LIST_SIZE),
    loadRecentSignups(LIST_SIZE),
    martFreshness(['DailyMetric', 'DailyRevenueRollup']),
  ]);

  const balanceByUser = new Map(failedPayments.map((payment) => [payment.user.id, payment.outstandingCents]));
  const failedInWindow = failedSeries.reduce((n, d) => n + d.valueInt, 0);

  // --- Series ---------------------------------------------------------------
  const signupSeries: SignupPoint[] = foldIntoBuckets<{ day: string; valueInt: number }, SignupPoint & { bucket: string }>(
    signupsNowSeries,
    window,
    'day',
    (row) => new Date(`${row.day}T00:00:00.000Z`),
    (bucket) => ({ ...seriesBase(bucket), signups: 0 }),
    (point, row) => {
      point.signups += row.valueInt;
    },
  ).map((point) => ({ label: point.label, signups: point.signups }));

  const revenueSeries: RevenuePoint[] = summary.revenueOverTime.map((point) => ({
    label: point.label,
    invoicedCents: point.invoicedCents,
    paidCents: point.paidCents,
  }));

  // --- Headline numbers -----------------------------------------------------
  const mrrDelta = summary.mrr.mrrCents - summary.openingMrrCents;
  const signupsNow = signupsNowSeries.reduce((n, d) => n + d.valueInt, 0);
  const previousSignups = signupsPrevSeries.reduce((n, d) => n + d.valueInt, 0);
  const signupDelta = signupsNow - previousSignups;

  const openTickets = ticketsSnap?.valueInt ?? 0;
  const breachedTickets = breachedSnap?.valueInt ?? 0;
  const overdueCount = overdueSnap?.valueInt ?? 0;
  const overdueCents = overdueCentsSnap?.valueCents ?? 0;
  const stale = freshness.filter((f) => f.stale);

  const churnParts = summary.churn.logoChurn.parts;
  const netNew = summary.movement.netNewMrrCents;

  return (
    <>
      <PageHeader
        title="Operations overview"
        description={`The last ${WINDOW_DAYS} days across revenue, growth and the queues. Everything below is CAD; USD is reported separately on the revenue page.`}
        action={
          canBill ? (
            <Link href="/console/revenue" className="btn-secondary px-3 py-2 text-xs">
              <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />
              Revenue analytics
            </Link>
          ) : undefined
        }
      />

      <p className={`mb-4 text-xs ${stale.length ? 'text-danger' : 'text-muted'}`}>
        {freshness.map(describeFreshness).join(' · ')}
        {stale.length ? ' - a stale mart shows the last rebuilt numbers; run npm run analytics:rollup.' : ''}
      </p>

      {/* Money first: the numbers a weekly review opens with. */}
      <div className="mb-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label="Monthly recurring revenue"
          value={money(summary.mrr.mrrCents)}
          tone="brand"
          icon={TrendingUp}
          delta={{
            label: `${mrrDelta >= 0 ? '+' : '−'}${compactMoney(Math.abs(mrrDelta))} in ${WINDOW_DAYS}d`,
            direction: mrrDelta > 0 ? 'up' : mrrDelta < 0 ? 'down' : 'flat',
            good: mrrDelta >= 0,
          }}
          hint={`${count(summary.mrr.payingSubscribers)} paying · ARPU ${money(summary.mrr.arpuCents)}`}
        />
        <Kpi
          label="Annual run rate"
          value={money(summary.mrr.arrCents)}
          hint="Today's MRR projected over twelve months — a snapshot, not booked revenue."
        />
        <Kpi
          label="Active subscriptions"
          value={count(summary.mrr.activeSubscribers)}
          href="/console/customers?stage=active"
          icon={Users}
          hint={
            <>
              {count(summary.mrr.trialingSubscribers)} trialing ·{' '}
              {count(summary.mrr.pastDueSubscribers)} past due{summary.subscriberSnapshotDay ? ` (as of ${summary.subscriberSnapshotDay})` : ' (no sweep yet)'}
            </>
          }
        />
        <Kpi
          label={`Net new MRR · ${WINDOW_DAYS}d`}
          value={`${netNew >= 0 ? '+' : '−'}${money(Math.abs(netNew))}`}
          tone={netNew > 0 ? 'positive' : netNew < 0 ? 'critical' : 'neutral'}
          hint={
            <>
              +{compactMoney(summary.movement.newMrrCents)} new, +
              {compactMoney(summary.movement.expansionMrrCents)} expansion, −
              {compactMoney(summary.movement.churnedMrrCents + summary.movement.contractionMrrCents)}{' '}
              lost
            </>
          }
        />
      </div>

      {/* Then the queues: what a person should do something about today. */}
      <div className="mb-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label={`New signups · ${WINDOW_DAYS}d`}
          value={count(signupsNow)}
          icon={UserPlus}
          delta={{
            label: `${signupDelta >= 0 ? '+' : '−'}${count(Math.abs(signupDelta))} vs previous ${WINDOW_DAYS}d`,
            direction: signupDelta > 0 ? 'up' : signupDelta < 0 ? 'down' : 'flat',
            good: signupDelta >= 0,
          }}
        />
        <Kpi
          label={`Logo churn · ${WINDOW_DAYS}d`}
          value={percent(summary.churn.logoChurn)}
          tone={churnParts >= 100_000 ? 'critical' : churnParts >= 50_000 ? 'caution' : 'neutral'}
          hint={
            summary.churn.logoChurn.denominator === 0
              ? 'No subscribers at the start of the window, so there is no rate to report.'
              : `${count(summary.movement.churnedSubscribers)} of ${count(summary.openingSubscribers)} lost`
          }
        />
        <Kpi
          label="Payments needing attention"
          value={count(failedInWindow)}
          tone={failedInWindow >= 5 ? 'critical' : failedInWindow > 0 ? 'caution' : 'positive'}
          icon={CreditCard}
          href={canBill ? '/console/invoices?status=open&overdue=1' : undefined}
          hint={
            overdueCount > 0
              ? `${count(overdueCount)} invoice${overdueCount === 1 ? '' : 's'} past due · ${money(overdueCents)} outstanding`
              : 'Nothing is past due.'
          }
        />
        <Kpi
          label="Open support tickets"
          value={count(openTickets)}
          tone={breachedTickets > 0 ? 'critical' : openTickets > 0 ? 'caution' : 'positive'}
          icon={LifeBuoy}
          href="/console/tickets"
          hint={
            breachedTickets > 0
              ? `${count(breachedTickets)} past their first-response SLA`
              : 'Every open ticket is still inside its SLA.'
          }
        />
      </div>

      <OverviewCharts
        revenue={revenueSeries}
        signups={signupSeries}
        currency={summary.currency}
        periodLabel={`last ${WINDOW_DAYS} days`}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        {/* --- Failed payments --- */}
        <Section
          id="failed-payments"
          title="Failed payments"
          description="Involuntary churn is the most recoverable kind. Work this list first."
          action={
            canBill ? (
              <Link
                href="/console/invoices?status=open&overdue=1"
                className="text-sm font-medium text-brand-500 hover:text-brand-600"
              >
                Overdue invoices
              </Link>
            ) : undefined
          }
        >
          <Card className="divide-y divide-line overflow-hidden p-0">
            {failedPayments.length === 0 ? (
              <Blank>
                No payment has failed in the last {WINDOW_DAYS} days. Nothing to chase.
              </Blank>
            ) : (
              failedPayments.map((payment) => {
                const outstanding = balanceByUser.get(payment.user.id) ?? payment.outstandingCents;
                return (
                  <div key={payment.id} className="flex items-start gap-3 p-4">
                    <span
                      aria-hidden="true"
                      className={`mt-1 h-8 w-1 shrink-0 rounded-full ${
                        outstanding > 0 ? 'bg-danger' : 'bg-line'
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <Link
                          href={`/console/customers/${payment.user.id}`}
                          className="truncate text-sm font-semibold text-ink hover:text-brand-600"
                        >
                          {payment.user.fullName || payment.user.email}
                        </Link>
                        <span className="truncate text-xs text-faint">{payment.user.email}</span>
                      </div>
                      <p className="mt-0.5 text-xs text-muted">
                        {money(payment.amountCents, payment.currency)} declined
                        {payment.failureCode ? ` — ${payment.failureCode.replace(/_/g, ' ')}` : ''}
                        {' · '}
                        {since(payment.failedAt ?? payment.createdAt, now)}
                      </p>
                    </div>
                    {outstanding > 0 ? (
                      <Pill tone="critical">{money(outstanding)} owing</Pill>
                    ) : (
                      <Pill tone="neutral">Settled since</Pill>
                    )}
                  </div>
                );
              })
            )}
          </Card>
          {failedInWindow > failedPayments.length && (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warn" aria-hidden="true" />
              {count(failedInWindow - failedPayments.length)} more failed in this window.
            </p>
          )}
        </Section>

        {/* --- Recent signups --- */}
        <Section
          id="recent-signups"
          title="Recent signups"
          description="The newest accounts, whether or not they have subscribed."
          action={
            <Link
              href="/console/customers"
              className="text-sm font-medium text-brand-500 hover:text-brand-600"
            >
              All customers
            </Link>
          }
        >
          <Card className="divide-y divide-line overflow-hidden p-0">
            {recentSignups.length === 0 ? (
              <Blank>No accounts have been created yet.</Blank>
            ) : (
              recentSignups.map((user) => (
                <Link
                  key={user.id}
                  href={`/console/customers/${user.id}`}
                  className="flex items-center gap-3 p-4 transition-colors duration-150 hover:bg-raised motion-reduce:transition-none"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink">
                      {user.fullName || user.email}
                    </p>
                    <p className="truncate text-xs text-muted">
                      {user.email}
                      {user.city ? ` · ${user.city}, ${user.country}` : ` · ${user.country}`}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    {user.subscription ? (
                      <Pill tone={user.subscription.status === 'active' ? 'positive' : 'brand'}>
                        {user.subscription.plan.name}
                      </Pill>
                    ) : (
                      <Pill tone="neutral">{user.onboardedAt ? 'No plan' : 'Onboarding'}</Pill>
                    )}
                    <span className="text-xs text-faint">{since(user.createdAt, now)}</span>
                  </div>
                  <ArrowRight className="h-4 w-4 shrink-0 text-faint" aria-hidden="true" />
                </Link>
              ))
            )}
          </Card>
        </Section>
      </div>
    </>
  );
}
