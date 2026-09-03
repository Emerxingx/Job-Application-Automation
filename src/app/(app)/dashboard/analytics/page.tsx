import Link from 'next/link';
import { BarChart3, KeyRound, Radar, Sparkles, Timer } from 'lucide-react';
import { requireTenant } from '@/lib/tenancy/request';
import { loadApplicationMetrics, loadMatchMetrics } from '@/lib/analytics/metrics';
import {
  formatDurationHours,
  formatRate,
  partsToPercent,
  type Rate,
} from '@/lib/analytics/types';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { AreaChartCard, BarChartCard } from '@/components/charts';
import { ExportButton } from '@/components/export-button';
import { PeriodPicker } from './period-picker';
import { parsePeriod, resolvePeriod } from './periods';
import {
  FunnelPanel,
  KeywordList,
  KpiCard,
  SectionCard,
  type Delta,
  type FunnelStageView,
  type KeywordRowView,
} from './panels';

export const metadata = { title: 'Analytics' };
export const dynamic = 'force-dynamic';

// --- Deltas -----------------------------------------------------------------
// A delta is only shown when the previous window is a fair comparison. "All
// time" has no preceding window, and a rate whose previous denominator was zero
// is not an improvement on anything — in both cases the line is omitted rather
// than filled with a number that reads as progress.

function signed(value: number): string {
  return `${value > 0 ? '+' : '-'}${Math.abs(value)}`;
}

function countDelta(current: number, previous: number, comparable: boolean): Delta | null {
  if (!comparable) return null;
  const change = current - previous;
  if (change === 0) return { text: 'No change', direction: 'flat' };
  return { text: signed(change), direction: change > 0 ? 'up' : 'down' };
}

function pointsDelta(
  current: number,
  previous: number,
  comparable: boolean,
  unit: string,
): Delta | null {
  if (!comparable) return null;
  const change = Math.round((current - previous) * 10) / 10;
  if (change === 0) return { text: 'No change', direction: 'flat' };
  return { text: `${signed(change)} ${unit}`, direction: change > 0 ? 'up' : 'down' };
}

function rateDelta(current: Rate, previous: Rate | undefined, comparable: boolean): Delta | null {
  if (!comparable || !previous || previous.denominator <= 0) return null;
  return pointsDelta(
    partsToPercent(current.parts),
    partsToPercent(previous.parts),
    true,
    'pts',
  );
}

function toKeywordRows(
  rows: { keyword: string; count: number; parts: number }[],
): KeywordRowView[] {
  return rows.map((row) => ({
    keyword: row.keyword,
    count: row.count,
    share: `${partsToPercent(row.parts).toFixed(0)}%`,
    percent: partsToPercent(row.parts),
  }));
}

// --- Page -------------------------------------------------------------------

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { user, run } = await requireTenant();
  const params = await searchParams;
  const period = resolvePeriod(parsePeriod(params.period), { since: user.createdAt });

  const [applications, matches, previousApplications, previousMatches, [lifetime, agentCount]] =
    await Promise.all([
      loadApplicationMetrics(user.id, {
        range: period.range,
        granularity: period.granularity,
        limit: 10,
      }),
      loadMatchMetrics(user.id, {
        range: period.range,
        granularity: period.granularity,
        limit: 8,
      }),
      period.comparable
        ? loadApplicationMetrics(user.id, {
            range: period.previous,
            granularity: period.granularity,
            limit: 1,
          })
        : null,
      period.comparable
        ? loadMatchMetrics(user.id, {
            range: period.previous,
            granularity: period.granularity,
            limit: 1,
          })
        : null,
      run((tx) =>
        Promise.all([
          tx.application.count({ where: { userId: user.id } }),
          tx.agent.count({ where: { userId: user.id } }),
        ]),
      ),
    ]);

  const totals = applications.totals;
  const funnel = applications.funnel;
  const response = applications.timeToFirstResponse;
  const hasDataInPeriod = totals.applications > 0 || matches.totalMatches > 0;

  const controls = (
    <div className="flex flex-wrap items-center gap-2">
      <PeriodPicker value={period.key} />
      <ExportButton
        endpoint="/api/exports/analytics"
        filename={`jobpilot-analytics-${period.key}`}
        params={{ from: period.from, to: period.to }}
        label="Export"
      />
    </div>
  );

  // Nothing has ever happened on this account — a report is not the answer,
  // creating an agent is.
  if (lifetime === 0 && matches.totalMatches === 0 && agentCount === 0) {
    return (
      <>
        <PageHeader
          title="Analytics"
          description="How your search is actually performing — and what to change about it."
        />
        <EmptyState
          icon={<BarChart3 className="h-5 w-5" />}
          title="No search data yet"
          description="Create a job agent and run a scan. Once postings are scored against your resume and you start applying, this page shows your response rate, your match quality and the keywords your resume keeps missing."
          action={
            <Link href="/dashboard/agents/new" className="btn-primary">
              <Radar className="h-4 w-4" />
              Create an agent
            </Link>
          }
        />
      </>
    );
  }

  const funnelStages: FunnelStageView[] = [
    {
      key: 'applied',
      label: 'Applied',
      count: totals.sent,
      note: 'Applications that reached the employer',
      conversion: null,
    },
    {
      key: 'responded',
      label: 'Employer replied',
      count: totals.responded,
      note: 'The earliest signal a human opened it',
      conversion: formatRate(funnel.responseRate),
    },
    {
      key: 'interview',
      label: 'Interview',
      count: totals.interviews,
      note: 'Replies that became a conversation',
      conversion: formatRate(funnel.interviewFromResponse),
    },
    {
      key: 'offer',
      label: 'Offer',
      count: totals.offers,
      note: 'Interviews that became an offer',
      conversion: formatRate(funnel.offerFromInterview),
    },
  ];

  const missingKeywords = toKeywordRows(matches.topMissingKeywords);
  const matchedKeywords = toKeywordRows(matches.topMatchedKeywords);

  return (
    <>
      <PageHeader
        title="Analytics"
        description={`How your search is performing over ${period.label}.`}
        action={controls}
      />

      {!hasDataInPeriod && (
        <Card className="mb-6 border-brand-500/40 bg-brand-500/5 p-4">
          <p className="text-sm text-ink">
            Nothing happened in {period.label}. Widen the period above to see your earlier
            activity.
          </p>
        </Card>
      )}

      {/* KPI row */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Applications"
          value={totals.applications}
          hint={`${totals.sent} reached an employer`}
          tone="brand"
          delta={countDelta(
            totals.applications,
            previousApplications?.totals.applications ?? 0,
            period.comparable,
          )}
        />
        <KpiCard
          label="Response rate"
          value={formatRate(funnel.responseRate)}
          hint={`${funnel.responseRate.numerator} of ${funnel.responseRate.denominator} sent`}
          delta={rateDelta(
            funnel.responseRate,
            previousApplications?.funnel.responseRate,
            period.comparable,
          )}
        />
        <KpiCard
          label="Interviews"
          value={totals.interviews}
          hint={totals.offers > 0 ? `${totals.offers} became an offer` : 'Including offers'}
          tone={totals.interviews > 0 ? 'success' : 'default'}
          delta={countDelta(
            totals.interviews,
            previousApplications?.totals.interviews ?? 0,
            period.comparable,
          )}
        />
        <KpiCard
          label="Average match score"
          value={matches.totalMatches > 0 ? matches.averageMatchScore : '—'}
          hint={`Across ${matches.totalMatches} scored role${matches.totalMatches === 1 ? '' : 's'}`}
          delta={
            previousMatches && previousMatches.totalMatches > 0
              ? pointsDelta(
                  matches.averageMatchScore,
                  previousMatches.averageMatchScore,
                  period.comparable,
                  'pts',
                )
              : null
          }
        />
      </div>

      {/* The actionable insight, given the room it deserves. */}
      <section className="mb-6 grid gap-4 lg:grid-cols-3">
        <SectionCard
          className="lg:col-span-2"
          title="Keywords your resume keeps missing"
          description="Counted across every role you were scored against in this period. Working the top few into your master resume raises the score on the next batch of matches — this is the single change with the most leverage on your results."
          action={
            <Link href="/dashboard/resume" className="btn-secondary px-3 py-1.5 text-xs">
              <KeyRound className="h-3.5 w-3.5" />
              Edit resume
            </Link>
          }
        >
          <KeywordList
            rows={missingKeywords}
            total={matches.totalMatches}
            tone="missing"
            emptyMessage={
              matches.totalMatches === 0
                ? 'No roles were scored in this period, so there is nothing to compare your resume against yet.'
                : 'Your resume covered every keyword the scorer looked for. Nothing to add.'
            }
          />
        </SectionCard>

        <SectionCard
          title="Already covered"
          description="Keywords your resume matched most often. Keep these prominent."
        >
          <KeywordList
            rows={matchedKeywords.slice(0, 6)}
            total={matches.totalMatches}
            tone="matched"
            emptyMessage="Once postings are scored against your resume, its strongest keywords appear here."
          />
        </SectionCard>
      </section>

      {/* Trend + funnel */}
      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <AreaChartCard
          className="lg:col-span-2"
          title="Applications over time"
          description={`One point per ${period.granularity} across ${period.label}.`}
          data={applications.overTime}
          xKey="label"
          series={[{ key: 'applications', label: 'Applications' }]}
          valueFormat="number"
          height={260}
          emptyTitle="No applications in this period"
          emptyDescription="Widen the period, or apply to a few roles from your job feed."
        />

        <SectionCard
          title="Response funnel"
          description="Where applications stop. JobPilot cannot see an employer opening a posting, so a reply is the first stage after sending."
        >
          <FunnelPanel stages={funnelStages} />
        </SectionCard>
      </div>

      {/* Match quality + response speed */}
      <div className="grid gap-4 lg:grid-cols-3">
        <BarChartCard
          className="lg:col-span-2"
          title="Match score distribution"
          description="How well the roles you were shown actually fit your resume."
          data={matches.distribution}
          xKey="label"
          series={[{ key: 'count', label: 'Roles scored' }]}
          valueFormat="number"
          height={240}
          emptyTitle="Nothing scored in this period"
          emptyDescription="Run a scan to pull live postings and score them against your resume."
        />

        <SectionCard
          title="How fast employers reply"
          description={
            response.samples > 0
              ? `Measured on ${response.samples} application${response.samples === 1 ? '' : 's'} that received a reply.`
              : 'Measured once an employer replies to something you sent.'
          }
        >
          {response.samples === 0 ? (
            <p className="flex items-center gap-2 py-4 text-sm text-muted">
              <Timer className="h-4 w-4 shrink-0 text-faint" aria-hidden="true" />
              No replies yet in this period.
            </p>
          ) : (
            <dl className="space-y-3">
              {[
                { label: 'Typical (median)', value: formatDurationHours(response.medianHours) },
                { label: 'Average', value: formatDurationHours(response.averageHours) },
                { label: 'Fastest', value: formatDurationHours(response.fastestHours) },
                { label: 'Slowest 10% wait', value: formatDurationHours(response.p90Hours) },
              ].map((row) => (
                <div key={row.label} className="flex items-baseline justify-between gap-3">
                  <dt className="text-sm text-muted">{row.label}</dt>
                  <dd className="text-sm font-semibold tabular-nums text-ink">{row.value}</dd>
                </div>
              ))}
            </dl>
          )}

          {totals.notSent > 0 && (
            <p className="mt-4 flex items-start gap-2 border-t border-line pt-3 text-xs text-muted">
              <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-500" aria-hidden="true" />
              {totals.notSent} application{totals.notSent === 1 ? ' is' : 's are'} still waiting to
              go out.{' '}
              <Link href="/dashboard/applications" className="font-medium text-brand-500 hover:text-brand-600">
                Review them
              </Link>
            </p>
          )}
        </SectionCard>
      </div>
    </>
  );
}
