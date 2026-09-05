import { CircleDollarSign, Percent, Repeat, TrendingDown, TrendingUp, Users } from 'lucide-react';
import { loadRevenueSummaryFromMarts } from '@/lib/analytics/finance/summary';
import { describeFreshness, martFreshness } from '@/lib/analytics/freshness';
import { rangeOfDays } from '@/lib/analytics/time';
import { type Granularity } from '@/lib/analytics/types';
import { Card, PageHeader, cn } from '@/components/ui';
import { consoleGate } from '../guard';
import {
  AccessDenied,
  Blank,
  Kpi,
  LinkTabs,
  Pill,
  Section,
  compactMoney,
  count,
  money,
  percent,
} from '../ui';
import { loadCohortGrid, MAX_COHORT_MONTHS, type CohortGrid } from './cohorts';
import {
  CashChart,
  MrrMovementChart,
  PlanMixChart,
  SubscriberChurnChart,
  type CashPoint,
  type ChurnPoint,
  type MovementPoint,
} from './revenue-charts';

export const metadata = { title: 'Revenue' };
export const dynamic = 'force-dynamic';

/**
 * The three windows this page offers.
 *
 * Granularity is tied to the window rather than exposed separately: 365 daily
 * columns is not a chart, it is a texture, and nobody has ever wanted monthly
 * buckets over a thirty-day range.
 */
const PERIODS = {
  '30d': { days: 30, granularity: 'day' as Granularity, label: 'Last 30 days', short: '30d' },
  '90d': { days: 90, granularity: 'day' as Granularity, label: 'Last 90 days', short: '90d' },
  '12m': { days: 365, granularity: 'month' as Granularity, label: 'Last 12 months', short: '12m' },
};

type PeriodKey = keyof typeof PERIODS;

/**
 * Currencies are reported side by side, never summed.
 *
 * There is no FX source installed, so CAD cents and USD cents are different
 * units. Adding them would produce a number that is wrong in both.
 */
const CURRENCIES = ['CAD', 'USD'] as const;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function one(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

export default async function ConsoleRevenuePage({ searchParams }: { searchParams: SearchParams }) {
  // Revenue reporting is what finance signs off on, so it sits a rung above the
  // support console rather than being open to every staff login.
  const gate = await consoleGate('billing_ops');
  if (!gate.ok) return <AccessDenied />;

  const params = await searchParams;
  const periodParam = one(params.period);
  const period: PeriodKey = periodParam in PERIODS ? (periodParam as PeriodKey) : '30d';
  const currencyParam = one(params.currency).toUpperCase();
  const currency = (CURRENCIES as readonly string[]).includes(currencyParam)
    ? currencyParam
    : 'CAD';

  const config = PERIODS[period];
  const now = new Date();
  const window = rangeOfDays(config.days, now);

  // Stage 21 (ADR-0036): the summary and the cohort grid are read from the
  // finance marts - the daily job paid for the source-table scans once. The
  // plan breakdown and the top failure codes are not in the wide row, so the
  // sections that need them say so rather than reading a transactional table.
  const [summary, cohorts, freshness] = await Promise.all([
    loadRevenueSummaryFromMarts({
      range: window,
      granularity: config.granularity,
      currency,
    }),
    loadCohortGrid(currency, now, MAX_COHORT_MONTHS),
    martFreshness(['DailyRevenueRollup', 'SubscriptionCohortMart']),
  ]);
  const stale = freshness.filter((f) => f.stale);

  const href = (next: { period?: string; currency?: string }) => {
    const search = new URLSearchParams();
    search.set('period', next.period ?? period);
    search.set('currency', next.currency ?? currency);
    return `/console/revenue?${search.toString()}`;
  };

  const movement = summary.movement;
  const grossGained =
    movement.newMrrCents + movement.expansionMrrCents + movement.reactivationMrrCents;
  const grossLost = movement.churnedMrrCents + movement.contractionMrrCents;

  const movementSeries: MovementPoint[] = summary.subscribersOverTime.map((point) => ({
    label: point.label,
    newMrrCents: point.newMrrCents,
    expansionMrrCents: point.expansionMrrCents,
    reactivationMrrCents: point.reactivationMrrCents,
    // Negated for the chart only. The stored magnitudes stay positive, which is
    // how every report and board deck reads them.
    contractionMrrCents: -point.contractionMrrCents,
    churnedMrrCents: -point.churnedMrrCents,
  }));

  const churnSeries: ChurnPoint[] = summary.subscribersOverTime.map((point) => ({
    label: point.label,
    newSubscribers: point.newSubscribers,
    churnedSubscribers: point.churnedSubscribers,
    reactivatedSubscribers: point.reactivatedSubscribers,
  }));

  const cashSeries: CashPoint[] = summary.revenueOverTime.map((point) => ({
    label: point.label,
    invoicedCents: point.invoicedCents,
    paidCents: point.paidCents,
    refundedCents: point.refundedCents,
  }));

  const nrrParts = summary.churn.netRevenueRetention.parts;
  const grossChurnParts = summary.churn.grossMrrChurn.parts;

  return (
    <>
      <PageHeader
        title="Revenue analytics"
        description={`Contracted revenue and collected cash for the ${config.label.toLowerCase()}, in ${currency}. The two are reported separately and never added together.`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <LinkTabs
              label="Reporting period"
              current={period}
              options={(Object.keys(PERIODS) as PeriodKey[]).map((key) => ({
                value: key,
                label: PERIODS[key].short,
                title: PERIODS[key].label,
                href: href({ period: key }),
              }))}
            />
      <p className={`mb-4 text-xs ${stale.length ? 'text-danger' : 'text-muted'}`}>
        {freshness.map(describeFreshness).join(' · ')}
        {stale.length ? ' - a stale mart shows the last rebuilt numbers; run npm run analytics:rollup.' : ''}
        {cohorts.asOf ? ` · cohorts as of ${cohorts.asOf.toISOString().slice(0, 10)}` : ''}
      </p>
            <LinkTabs
              label="Currency"
              current={currency}
              options={CURRENCIES.map((code) => ({
                value: code,
                label: code,
                title: `Report in ${code}`,
                href: href({ currency: code }),
              }))}
            />
          </div>
        }
      />

      {/* --- Headline --- */}
      <div className="mb-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label="Monthly recurring revenue"
          value={money(summary.mrr.mrrCents, currency)}
          tone="brand"
          icon={TrendingUp}
          delta={{
            label: `${movement.netNewMrrCents >= 0 ? '+' : '−'}${compactMoney(Math.abs(movement.netNewMrrCents), currency)} net this period`,
            direction:
              movement.netNewMrrCents > 0 ? 'up' : movement.netNewMrrCents < 0 ? 'down' : 'flat',
            good: movement.netNewMrrCents >= 0,
          }}
          hint={summary.mrrReportedIn !== currency ? `MRR, ARR, ARPU and lifetime value are reported in ${summary.mrrReportedIn} only; select ${summary.mrrReportedIn} to see them.` : summary.openingCovered ? `Opened the period at ${money(summary.openingMrrCents, currency)}` : 'Opening MRR unavailable: the mart lacks the day before this period - run npm run analytics:rollup over a longer window.'}
        />
        <Kpi
          label="Annual run rate"
          value={money(summary.mrr.arrCents, currency)}
          icon={CircleDollarSign}
          hint={summary.mrrReportedIn !== currency ? `Reported in ${summary.mrrReportedIn} only.` : `MRR × 12. A projection of the book at the end of ${summary.asOfDay ?? 'the period'}, not booked revenue.`}
        />
        <Kpi
          label="ARPU"
          value={money(summary.mrr.arpuCents, currency)}
          icon={Users}
          hint={summary.mrrReportedIn !== currency ? `Reported in ${summary.mrrReportedIn} only.` : `Across ${count(summary.mrr.payingSubscribers)} paying subscribers — trials excluded.`}
        />
        <Kpi
          label="Predicted lifetime value"
          value={money(summary.ltv.ltvCents, currency)}
          icon={Repeat}
          hint={
            summary.ltv.capped
              ? `ARPU × ${summary.ltv.expectedLifetimeMonths} months — capped, because the churn rate implies a longer life than we will forecast.`
              : `ARPU ÷ monthly churn ≈ ${summary.ltv.expectedLifetimeMonths} months of life.`
          }
        />
      </div>

      <div className="mb-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label="Logo churn"
          value={percent(summary.churn.logoChurn)}
          tone={
            summary.churn.logoChurn.parts >= 100_000
              ? 'critical'
              : summary.churn.logoChurn.parts >= 50_000
                ? 'caution'
                : 'neutral'
          }
          icon={TrendingDown}
          hint={
            summary.churn.logoChurn.denominator === 0
              ? 'Nobody was subscribed at the start of the period, so there is no rate.'
              : `${count(movement.churnedSubscribers)} of ${count(summary.openingSubscribers)} subscribers lost`
          }
        />
        <Kpi
          label="Gross MRR churn"
          value={percent(summary.churn.grossMrrChurn)}
          tone={grossChurnParts >= 80_000 ? 'critical' : grossChurnParts >= 40_000 ? 'caution' : 'neutral'}
          icon={Percent}
          hint={`${money(grossLost, currency)} lost to cancellation and downgrade`}
        />
        <Kpi
          label="Net revenue retention"
          value={percent(summary.churn.netRevenueRetention)}
          tone={
            summary.churn.netRevenueRetention.denominator === 0
              ? 'neutral'
              : nrrParts >= 1_000_000
                ? 'positive'
                : nrrParts >= 900_000
                  ? 'caution'
                  : 'critical'
          }
          hint="Existing customers only — new business is excluded so a good sales month cannot hide a leaking bucket."
        />
        <Kpi
          label="Collected"
          value={money(summary.totals.paidCents, currency)}
          tone="positive"
          hint={`Net of ${money(summary.totals.refundedCents, currency)} refunded and ${money(summary.totals.feeCents, currency)} in gateway fees → ${money(summary.totals.netCents, currency)}`}
        />
      </div>

      {/* --- Movement --- */}
      <Section
        id="movement"
        title="MRR movement"
        description="Where the change in recurring revenue came from over the period."
      >
        <div className="mb-4 grid gap-3 sm:grid-cols-3 xl:grid-cols-5">
          <MovementTile label="New" cents={movement.newMrrCents} currency={currency} good />
          <MovementTile
            label="Expansion"
            cents={movement.expansionMrrCents}
            currency={currency}
            good
          />
          <MovementTile
            label="Reactivation"
            cents={movement.reactivationMrrCents}
            currency={currency}
            good
          />
          <MovementTile
            label="Contraction"
            cents={movement.contractionMrrCents}
            currency={currency}
          />
          <MovementTile label="Churn" cents={movement.churnedMrrCents} currency={currency} />
        </div>

        <MrrMovementChart
          data={movementSeries}
          currency={currency}
          title={`MRR movement — ${config.label.toLowerCase()}`}
        />

        <p className="mt-3 text-xs text-muted">
          Gained {money(grossGained, currency)} · lost {money(grossLost, currency)} · net{' '}
          <span
            className={cn(
              'font-semibold',
              movement.netNewMrrCents >= 0 ? 'text-success' : 'text-danger',
            )}
          >
            {movement.netNewMrrCents >= 0 ? '+' : '−'}
            {money(Math.abs(movement.netNewMrrCents), currency)}
          </span>
          .
        </p>
      </Section>

      {/* --- Plan mix and churn --- */}
      <Section
        id="mix"
        title="Where the revenue sits"
        description="Plan mix today, and how the subscriber base moved over the period."
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <PlanMixChart
            slices={summary.mrr.byPlan.map((plan) => ({
              id: plan.planCode,
              label: plan.planName,
              value: plan.mrrCents,
            }))}
            currency={currency}
            totalLabel={compactMoney(summary.mrr.mrrCents, currency)}
          />
          <SubscriberChurnChart
            data={churnSeries}
            title={`Subscriber movement — ${config.label.toLowerCase()}`}
          />
        </div>

        {summary.mrr.byPlan.length === 0 && (
          <p className="mt-4 text-xs text-muted">The plan breakdown is not held in the revenue mart (ADR-0036: the wide row carries totals, not a per-plan split), so it is not shown rather than read live from subscriptions.</p>
        )}
        {summary.mrr.byPlan.length > 0 && (
          <Card className="mt-4 overflow-hidden p-0">
            <div className="scroll-x">
              <table className="w-full border-collapse text-sm">
                <caption className="sr-only">Monthly recurring revenue by plan</caption>
                <thead>
                  <tr className="border-b border-line text-xs uppercase tracking-wide text-faint">
                    <th scope="col" className="px-4 py-2.5 text-left font-semibold">
                      Plan
                    </th>
                    <th scope="col" className="px-4 py-2.5 text-right font-semibold">
                      Subscribers
                    </th>
                    <th scope="col" className="px-4 py-2.5 text-right font-semibold">
                      MRR
                    </th>
                    <th scope="col" className="px-4 py-2.5 text-right font-semibold">
                      Share
                    </th>
                    <th scope="col" className="px-4 py-2.5 text-right font-semibold">
                      MRR per subscriber
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {summary.mrr.byPlan.map((plan) => (
                    <tr key={plan.planCode} className="border-b border-line last:border-0">
                      <td className="px-4 py-3 font-semibold text-ink">{plan.planName}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-muted">
                        {count(plan.subscribers)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-ink">
                        {money(plan.mrrCents, currency)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-muted">
                        {(plan.parts / 10_000).toFixed(1)}%
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-muted">
                        {money(
                          plan.subscribers > 0 ? Math.round(plan.mrrCents / plan.subscribers) : 0,
                          currency,
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </Section>

      {/* --- Cash --- */}
      <Section
        id="cash"
        title="Cash collected"
        description="What was billed and what actually arrived. An annual plan bills once and contributes to MRR twelve times."
      >
        <CashChart
          data={cashSeries}
          currency={currency}
          title={`Billed and collected — ${config.label.toLowerCase()}`}
        />

        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Kpi
            label="Invoiced"
            value={money(summary.totals.invoicedCents, currency)}
            hint={`${count(summary.totals.invoices)} invoice${summary.totals.invoices === 1 ? '' : 's'}, drafts and voids excluded`}
          />
          <Kpi
            label="Tax collected"
            value={money(summary.totals.taxCents, currency)}
            hint="Remittable — this is not revenue."
          />
          <Kpi
            label="Payment failure rate"
            value={percent(summary.paymentHealth.failureRate)}
            tone={
              summary.paymentHealth.failureRate.parts >= 150_000
                ? 'critical'
                : summary.paymentHealth.failureRate.parts >= 70_000
                  ? 'caution'
                  : 'positive'
            }
            hint={`${count(summary.paymentHealth.failed)} failed of ${count(summary.paymentHealth.failed + summary.paymentHealth.succeeded)} resolved attempts`}
          />
          <Kpi
            label="Value of failed charges"
            value={money(summary.paymentHealth.failedCents, currency)}
            tone={summary.paymentHealth.failedCents > 0 ? 'caution' : 'positive'}
            hint="Recoverable through dunning — chase it before it becomes churn."
          />
        </div>

        {summary.paymentHealth.topFailureCodes.length === 0 && (
          <p className="mt-4 text-xs text-muted">Failure codes are not held in the revenue mart, so the reasons are not shown here; the failed-payments queue on the overview names each one.</p>
        )}
        {summary.paymentHealth.topFailureCodes.length > 0 && (
          <Card className="mt-4 p-4">
            <h3 className="mb-3 text-sm font-semibold text-ink">Why payments failed</h3>
            <ul className="flex flex-wrap gap-2">
              {summary.paymentHealth.topFailureCodes.map((code) => (
                <li key={code.key}>
                  <Pill tone="caution">
                    {code.key.replace(/_/g, ' ')} · {count(code.count)} (
                    {(code.parts / 10_000).toFixed(0)}%)
                  </Pill>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </Section>

      {/* --- Cohorts --- */}
      <Section
        id="cohorts"
        title="Cohort retention"
        description="Of the subscriptions that started in a month, how many were still subscribed later. Logos, not revenue."
      >
        <CohortTable grid={cohorts} currency={currency} />
      </Section>
    </>
  );
}

/** One movement figure. Losses are printed with a minus so the sign is visible. */
function MovementTile({
  label,
  cents,
  currency,
  good = false,
}: {
  label: string;
  cents: number;
  currency: string;
  good?: boolean;
}) {
  const zero = cents === 0;
  return (
    <div className="card p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-faint">{label}</p>
      <p
        className={cn(
          'mt-1 text-lg font-bold tabular-nums',
          zero ? 'text-faint' : good ? 'text-success' : 'text-danger',
        )}
      >
        {zero ? '—' : `${good ? '+' : '−'}${money(cents, currency)}`}
      </p>
    </div>
  );
}

/**
 * The retention grid.
 *
 * Cells are shaded by retention AND print the percentage, because a heatmap
 * where the number is only in the colour cannot be read by anyone with a colour
 * vision deficiency, printed in greyscale, or quoted in a meeting. Cells past
 * the current month are absent rather than zero — a cohort three months old has
 * no month-6 number, and 0% would read as total churn.
 */
function CohortTable({ grid, currency }: { grid: CohortGrid; currency: string }) {
  if (grid.totalSubscriptions === 0) {
    return (
      <Card className="p-0">
        <Blank>
          No {currency} subscriptions started in the last {MAX_COHORT_MONTHS} months, so there is no
          cohort to follow yet.
        </Blank>
      </Card>
    );
  }

  const shade = (parts: number): string => {
    if (parts >= 900_000) return 'bg-success/25 text-success';
    if (parts >= 700_000) return 'bg-success/15 text-success';
    if (parts >= 500_000) return 'bg-warn/15 text-warn';
    if (parts >= 250_000) return 'bg-warn/25 text-warn';
    return 'bg-danger/20 text-danger';
  };

  return (
    <Card className="overflow-hidden p-0">
      <div className="scroll-x">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            Cohort retention by signup month, {currency} subscriptions
          </caption>
          <thead>
            <tr className="border-b border-line text-xs uppercase tracking-wide text-faint">
              <th scope="col" className="px-4 py-2.5 text-left font-semibold">
                Cohort
              </th>
              <th scope="col" className="px-3 py-2.5 text-right font-semibold">
                Size
              </th>
              {grid.offsets.map((offset) => (
                <th key={offset} scope="col" className="px-3 py-2.5 text-center font-semibold">
                  M{offset}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((row) => (
              <tr key={row.key} className="border-b border-line last:border-0">
                <th scope="row" className="whitespace-nowrap px-4 py-2 text-left font-semibold text-ink">
                  {row.label}
                </th>
                <td className="px-3 py-2 text-right tabular-nums text-muted">{row.size}</td>
                {grid.offsets.map((offset) => {
                  const cell = row.cells[offset];
                  if (!cell) {
                    return (
                      <td key={offset} className="px-3 py-2 text-center text-faint">
                        <span className="sr-only">Not yet elapsed</span>
                        <span aria-hidden="true">·</span>
                      </td>
                    );
                  }
                  if (row.size === 0) {
                    return (
                      <td key={offset} className="px-3 py-2 text-center text-faint">
                        —
                      </td>
                    );
                  }
                  return (
                    <td key={offset} className="px-1.5 py-1.5 text-center">
                      <span
                        title={`${cell.retained} of ${row.size} still subscribed`}
                        className={cn(
                          'inline-block w-full rounded-lg px-2 py-1 text-xs font-semibold tabular-nums',
                          shade(cell.parts),
                        )}
                      >
                        {Math.round(cell.parts / 10_000)}%
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-line px-4 py-3 text-xs text-faint">
        A subscription counts as retained in a month when it had not been cancelled or suspended
        before that month began. Month 0 is the month they joined, so it is always 100%.
      </p>
    </Card>
  );
}
