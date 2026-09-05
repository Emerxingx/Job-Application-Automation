import Link from 'next/link';
import { BarChart3, KeyRound, Radar, Sparkles, Timer } from 'lucide-react';
import { requireTenant } from '@/lib/tenancy/request';
import { currentImpersonation } from '@/lib/auth';
import { readBenchmark, readCandidateMatches, readCandidateOutcomes, readCandidateTotals, type CandidateOutcomes } from '@/lib/analytics/candidate/read';
import { candidateMartFreshness, refreshCandidateMarts } from '@/lib/analytics/candidate/rollup';
import { DIMENSION_LABELS, type Dimension } from '@/lib/analytics/candidate/dictionary';
import { formatDurationHours, formatRate, partsToPercent, type Rate } from '@/lib/analytics/types';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { AreaChartCard, BarChartCard } from '@/components/charts';
import { ExportButton } from '@/components/export-button';
import { AnalyticsFreshness } from '@/components/analytics-freshness';
import { PeriodPicker } from './period-picker';
import { parsePeriod, resolvePeriod } from './periods';
import { FunnelPanel, KeywordList, KpiCard, SectionCard, type Delta, type FunnelStageView, type KeywordRowView } from './panels';
import { redactError } from '@/lib/log';

export const metadata = { title: 'Analytics' };
export const dynamic = 'force-dynamic';

// --- Deltas -----------------------------------------------------------------
// A delta is only shown when the previous window is a fair comparison. "All
// time" has no preceding window, and a rate whose previous denominator was zero
// is not an improvement on anything - in both cases the line is omitted rather
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

function pointsDelta(current: number, previous: number, comparable: boolean, unit: string): Delta | null {
  if (!comparable) return null;
  const change = Math.round((current - previous) * 10) / 10;
  if (change === 0) return { text: 'No change', direction: 'flat' };
  return { text: `${signed(change)} ${unit}`, direction: change > 0 ? 'up' : 'down' };
}

function rateDelta(current: Rate, previous: Rate | undefined, comparable: boolean): Delta | null {
  if (!comparable || !previous || previous.denominator <= 0) return null;
  return pointsDelta(partsToPercent(current.parts), partsToPercent(previous.parts), true, 'pts');
}

function toKeywordRows(rows: { keyword: string; count: number; parts: number }[]): KeywordRowView[] {
  return rows.map((row) => ({ keyword: row.keyword, count: row.count, share: `${partsToPercent(row.parts).toFixed(0)}%`, percent: partsToPercent(row.parts) }));
}

const CUT_DIMENSIONS: Exclude<Dimension, 'all'>[] = ['title', 'company', 'seniority', 'geography', 'source', 'resume_version', 'score_band'];

// --- Page -------------------------------------------------------------------

/**
 * /dashboard/analytics - Stage 13 (ADR-0012, ADR-0027): every number here is
 * read from the candidate's outcome and match MARTS on the tenant path, through
 * the metric dictionary. No query on this page touches a transactional table
 * (a static test enforces it). The one exception is deliberate and bounded: a
 * candidate whose marts hold nothing yet triggers a rebuild of THEIR OWN rows
 * once, so the first visit is not an empty page pointing at a button.
 */
export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const { user, run } = await requireTenant();
  const params = await searchParams;
  const period = resolvePeriod(parsePeriod(params.period), { since: user.createdAt });

  // Once, on the first visit (never built for this candidate): a rebuild of
  // THEIR rows, then the flag is set - so a candidate with no applications does
  // not pay for a rebuild on every visit. A flag read, not a metric.
  const built = await run((tx) => tx.user.findUnique({ where: { id: user.id }, select: { analyticsBuiltAt: true } }));
  // Never under a support impersonation (Stage 20 review, M7): a read-only
  // session writes nothing, not even the person's own marts.
  if (!built?.analyticsBuiltAt && !(await currentImpersonation())) {
    await refreshCandidateMarts(user.id).catch((error) => console.error('[analytics] first-visit refresh failed:', redactError(error).message));
  }
  const lifetime = await run((tx) => readCandidateTotals(tx, user.id));

  const [outcomes, matches, previous, agentCount, freshness] = await Promise.all([
    run((tx) => readCandidateOutcomes(tx, user.id, period.range, period.granularity, 10)),
    run((tx) => readCandidateMatches(tx, user.id, period.range, 10)),
    period.comparable ? run((tx) => readCandidateOutcomes(tx, user.id, period.previous, period.granularity, 1)) : Promise.resolve<CandidateOutcomes | null>(null),
    run((tx) => tx.agent.count({ where: { userId: user.id } })),
    candidateMartFreshness(),
  ]);

  const totals = outcomes.totals;
  const rates = outcomes.rates;
  const hasDataInPeriod = totals.applications > 0 || matches.totalMatches > 0;
  // The platform comparison for the candidate's most-applied title, under the
  // small-cohort rule: a group under five people yields no number and says why.
  const topTitle = outcomes.cuts.title[0]?.key ?? null;
  const benchmark = topTitle ? await readBenchmark('title', topTitle, period.range) : null;
  const freshnessView = <AnalyticsFreshness lastSucceededAt={freshness.lastSucceededAt?.toISOString() ?? null} lastStatus={freshness.lastStatus} stale={freshness.stale} />;

  const controls = (
    <div className="flex flex-wrap items-center gap-2">
      <PeriodPicker value={period.key} />
      <ExportButton endpoint="/api/exports/analytics" filename={`jobpilot-analytics-${period.key}`} params={{ from: period.from, to: period.to }} label="Export" />
    </div>
  );

  // Nothing has ever happened on this account - a report is not the answer,
  // creating an agent is.
  if (lifetime.applications === 0 && matches.totalMatches === 0 && agentCount === 0) {
    return (
      <>
        <PageHeader title="Analytics" description="How your search is actually performing - and what to change about it." />
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
    { key: 'applied', label: 'Sent', count: totals.sent, note: 'Applications that reached the employer', conversion: null },
    { key: 'responded', label: 'Employer replied', count: totals.responded, note: 'The earliest signal a human opened it', conversion: formatRate(rates.responseRate) },
    { key: 'interview', label: 'Interview', count: totals.interviews, note: 'Replies that became a conversation', conversion: formatRate(rates.interviewFromResponse) },
    { key: 'offer', label: 'Offer', count: totals.offers, note: 'Interviews that became an offer', conversion: formatRate(rates.offerFromInterview) },
  ];

  const missingKeywords = toKeywordRows(matches.topMissingKeywords);
  const matchedKeywords = toKeywordRows(matches.topMatchedKeywords);
  const distribution = matches.bands.map((b) => ({ label: b.band, count: b.count }));
  const notSent = totals.applications - totals.sent - totals.failed;

  return (
    <>
      <PageHeader title="Analytics" description={`How your search is performing over ${period.label}.`} action={controls} />
      <div className="mb-4">{freshnessView}</div>

      {!hasDataInPeriod && (
        <Card className="mb-6 border-brand-500/40 bg-brand-500/5 p-4">
          <p className="text-sm text-ink">Nothing happened in {period.label}. Widen the period above to see your earlier activity.</p>
        </Card>
      )}

      {/* KPI row - each one a dictionary metric */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Applications" value={totals.applications} hint={`${totals.sent} reached an employer`} tone="brand" delta={countDelta(totals.applications, previous?.totals.applications ?? 0, period.comparable)} />
        <KpiCard label="Response rate" value={formatRate(rates.responseRate)} hint={`${rates.responseRate.numerator} of ${rates.responseRate.denominator} sent`} delta={rateDelta(rates.responseRate, previous?.rates.responseRate, period.comparable)} />
        <KpiCard label="Interviews" value={totals.interviews} hint={totals.offers > 0 ? `${totals.offers} became an offer${totals.hires > 0 ? `, ${totals.hires} hired` : ''}` : 'Including offers'} tone={totals.interviews > 0 ? 'success' : 'default'} delta={countDelta(totals.interviews, previous?.totals.interviews ?? 0, period.comparable)} />
        <KpiCard label="Average match score" value={matches.totalMatches > 0 ? matches.averageMatchScore : '-'} hint={`Across ${matches.totalMatches} scored role${matches.totalMatches === 1 ? '' : 's'}`} delta={null} />
      </div>

      {/* The actionable insight, given the room it deserves. */}
      <section className="mb-6 grid gap-4 lg:grid-cols-3">
        <SectionCard
          className="lg:col-span-2"
          title="Keywords your resume keeps missing"
          description="Counted across every role you were scored against in this period. Working the top few into your master resume raises the score on the next batch of matches - this is the single change with the most leverage on your results."
          action={
            <Link href="/dashboard/resume" className="btn-secondary px-3 py-1.5 text-xs">
              <KeyRound className="h-3.5 w-3.5" />
              Edit resume
            </Link>
          }
        >
          <KeywordList rows={missingKeywords} total={matches.totalMatches} tone="missing" emptyMessage={matches.totalMatches === 0 ? 'No roles were scored in this period, so there is nothing to compare your resume against yet.' : 'Your resume covered every keyword the scorer looked for. Nothing to add.'} />
        </SectionCard>

        <SectionCard title="Already covered" description="Keywords your resume matched most often. Keep these prominent.">
          <KeywordList rows={matchedKeywords.slice(0, 6)} total={matches.totalMatches} tone="matched" emptyMessage="Once postings are scored against your resume, its strongest keywords appear here." />
        </SectionCard>
      </section>

      {/* Trend + funnel */}
      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <AreaChartCard className="lg:col-span-2" title="Applications over time" description={`One point per ${period.granularity} across ${period.label}.`} data={outcomes.overTime} xKey="label" series={[{ key: 'applications', label: 'Applications' }]} valueFormat="number" height={260} emptyTitle="No applications in this period" emptyDescription="Widen the period, or apply to a few roles from your job feed." />

        <SectionCard title="Response funnel" description="Where applications stop. JobPilot cannot see an employer opening a posting, so a reply is the first stage after sending.">
          <FunnelPanel stages={funnelStages} />
        </SectionCard>
      </div>

      {topTitle && benchmark && (
        <Card className="mb-6 p-4">
          <h2 className="font-semibold text-ink">Everyone applying to &ldquo;{topTitle}&rdquo;</h2>
          {benchmark.suppressed ? (
            <p className="mt-1 text-sm text-muted">{benchmark.reason}</p>
          ) : (
            <p className="mt-1 text-sm text-muted">
              Across {benchmark.value.users}+ people and {benchmark.value.sent} sent applications in {period.label}: response rate {formatRate(benchmark.value.responseRate)}, interview rate {formatRate(benchmark.value.interviewRate)}, offer rate {formatRate(benchmark.value.offerRate)}. Yours: {formatRate(outcomes.cuts.title[0].responseRate)} response rate on {outcomes.cuts.title[0].sent} sent.
            </p>
          )}
        </Card>
      )}

      {/* Cuts - the same five numbers by every dimension the dictionary names */}
      <section className="mb-6 grid gap-4 lg:grid-cols-2">
        {CUT_DIMENSIONS.map((dimension) => {
          const rows = outcomes.cuts[dimension];
          return (
            <SectionCard key={dimension} title={`By ${DIMENSION_LABELS[dimension].toLowerCase()}`} description="Sent, replied, interviews and the response rate for each group in this period. Groups are yours alone; the platform comparison is on each application." >
              {rows.length === 0 ? (
                <p className="py-3 text-sm text-muted">Nothing in this period.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase tracking-wide text-muted">
                        <th className="py-1 pr-2 font-medium">{DIMENSION_LABELS[dimension]}</th>
                        <th className="py-1 pr-2 text-right font-medium">Apps</th>
                        <th className="py-1 pr-2 text-right font-medium">Sent</th>
                        <th className="py-1 pr-2 text-right font-medium">Replied</th>
                        <th className="py-1 pr-2 text-right font-medium">Interviews</th>
                        <th className="py-1 text-right font-medium">Response</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.key} className="border-t border-line">
                          <td className="max-w-[14rem] truncate py-1 pr-2 text-ink" title={row.key}>{row.key}</td>
                          <td className="py-1 pr-2 text-right tabular-nums">{row.applications}</td>
                          <td className="py-1 pr-2 text-right tabular-nums">{row.sent}</td>
                          <td className="py-1 pr-2 text-right tabular-nums">{row.responded}</td>
                          <td className="py-1 pr-2 text-right tabular-nums">{row.interviews}</td>
                          <td className="py-1 text-right tabular-nums">{row.sent > 0 ? formatRate(row.responseRate) : '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>
          );
        })}
      </section>

      {/* Match quality + response speed */}
      <div className="grid gap-4 lg:grid-cols-3">
        <BarChartCard className="lg:col-span-2" title="Match score distribution" description="How well the roles you were shown actually fit your resume, by score band." data={distribution} xKey="label" series={[{ key: 'count', label: 'Roles scored' }]} valueFormat="number" height={240} emptyTitle="Nothing scored in this period" emptyDescription="Run a scan to pull live postings and score them against your resume." />

        <SectionCard title="How fast employers reply" description={totals.responseSamples > 0 ? `Measured on ${totals.responseSamples} application${totals.responseSamples === 1 ? '' : 's'} that received a reply.` : 'Measured once an employer replies to something you sent.'}>
          {totals.responseSamples === 0 ? (
            <p className="flex items-center gap-2 py-4 text-sm text-muted">
              <Timer className="h-4 w-4 shrink-0 text-faint" aria-hidden="true" />
              No replies yet in this period.
            </p>
          ) : (
            <dl className="space-y-3">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-sm text-muted">Average</dt>
                <dd className="text-sm font-semibold tabular-nums text-ink">{formatDurationHours(outcomes.averageResponseHours)}</dd>
              </div>
            </dl>
          )}

          {notSent > 0 && (
            <p className="mt-4 flex items-start gap-2 border-t border-line pt-3 text-xs text-muted">
              <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-500" aria-hidden="true" />
              {notSent} application{notSent === 1 ? ' is' : 's are'} still waiting to go out.{' '}
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
