import type { ReactElement } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  FolderTree,
  Info,
  Radar,
  Search,
  Sparkles,
  TrendingUp,
} from 'lucide-react';
import type { Agent, ActivityEvent, Job, JobMatch } from '@prisma/client';
import type { QuotaStatus } from '@/lib/subscription';
import type { DashboardWidget } from '@/lib/cms';
import {
  Card,
  EmptyState,
  ScoreRing,
  Stat,
  StatusBadge,
  formatRelative,
} from '@/components/ui';
import { ScanButton } from '@/components/scan-button';

/**
 * The dashboard's widget library.
 *
 * Each widget is real application code: it receives pre-loaded, already
 * user-scoped data from the page shell and renders one section of the
 * dashboard. The CMS decides which widgets appear, in what order, with what
 * copy (via src/cms/blocks-dashboard.ts) — and nothing else. Data loading
 * and auth live in the shell, so no layout edit can widen what a widget
 * sees or change what its actions do.
 *
 * Adding a widget = add a component here, a block in blocks-dashboard.ts,
 * and a case in renderDashboardWidget. Type safety keeps the three in sync.
 */

export interface DashboardData {
  firstName: string;
  quota: QuotaStatus | null;
  agentCount: number;
  applicationCount: number;
  submittedCount: number;
  interviewCount: number;
  /** Ordered best-first; widgets slice to their configured count. */
  topMatches: (JobMatch & { job: Job })[];
  /** Ordered newest-first. */
  events: ActivityEvent[];
  agents: Pick<Agent, 'id'>[];
}

// --- Widgets ---------------------------------------------------------------

function StatsRow({ stats, data }: { stats: string[]; data: DashboardData }) {
  const responseRate =
    data.applicationCount > 0
      ? Math.round((data.interviewCount / data.applicationCount) * 100)
      : 0;

  const tiles: Record<string, ReactElement> = {
    applications: (
      <Stat
        key="applications"
        label="Applications sent"
        value={data.submittedCount}
        hint={data.quota ? `${data.quota.remaining} left this cycle` : undefined}
        tone="brand"
      />
    ),
    agents: (
      <Stat key="agents" label="Active agents" value={data.agentCount} hint="Scanning live postings" />
    ),
    matches: (
      <Stat
        key="matches"
        label="New matches"
        value={data.topMatches.length ? `${data.topMatches.length}+` : 0}
        hint="Waiting for your review"
      />
    ),
    interviewRate: (
      <Stat
        key="interviewRate"
        label="Interview rate"
        value={`${responseRate}%`}
        hint={`${data.interviewCount} moved forward`}
        tone={responseRate > 0 ? 'success' : 'default'}
      />
    ),
  };

  const chosen = stats.filter((s) => s in tiles);
  if (chosen.length === 0) return null;

  return (
    <div
      className={`mb-8 grid gap-4 sm:grid-cols-2 ${chosen.length >= 4 ? 'lg:grid-cols-4' : `lg:grid-cols-${chosen.length}`}`}
    >
      {chosen.map((s) => tiles[s])}
    </div>
  );
}

function GettingStarted({
  heading,
  body,
  ctaLabel,
  data,
}: {
  heading: string;
  body: string;
  ctaLabel: string;
  data: DashboardData;
}) {
  // Only shown while the account has no agents — that condition is behaviour,
  // not layout, so it stays in code rather than in the CMS.
  if (data.agentCount > 0) return null;

  return (
    <Card className="mb-8 border-brand-500/40 bg-brand-500/5 p-6">
      <div className="flex items-start gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-500/10">
          <Sparkles className="h-5 w-5 text-brand-500" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-ink">{heading}</h2>
          <p className="mt-1 text-sm text-muted">{body}</p>
          <Link href="/dashboard/agents/new" className="btn-primary mt-4">
            {ctaLabel}
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </Card>
  );
}

function TopMatches({ heading, count, data }: { heading: string; count: number; data: DashboardData }) {
  const matches = data.topMatches.slice(0, count);

  return (
    <section className="lg:col-span-2">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-ink">{heading}</h2>
        <Link href="/dashboard/jobs" className="text-sm font-medium text-brand-500 hover:text-brand-600">
          View all
        </Link>
      </div>

      {matches.length === 0 ? (
        <EmptyState
          icon={<Search className="h-5 w-5" />}
          title="No matches yet"
          description={
            data.agentCount === 0
              ? 'Create a job agent and run a scan to see live postings scored against your resume.'
              : 'Run a scan to pull the latest live postings for your agents.'
          }
          action={
            data.agentCount === 0 ? (
              <Link href="/dashboard/agents/new" className="btn-primary">
                <Radar className="h-4 w-4" />
                Create an agent
              </Link>
            ) : (
              <ScanButton label="Run a scan" />
            )
          }
        />
      ) : (
        <ul className="space-y-3">
          {matches.map((match) => (
            <Card as="li" key={match.id} className="p-4">
              <div className="flex items-start gap-4">
                <ScoreRing score={match.matchScore} />
                <div className="min-w-0 flex-1">
                  <h3 className="truncate font-semibold text-ink">{match.job.title}</h3>
                  <p className="truncate text-sm text-muted">
                    {match.job.company} · {match.job.location}
                  </p>
                  <p className="mt-1.5 line-clamp-2 text-xs text-faint">{match.rationale}</p>
                </div>
                <Link
                  href={`/dashboard/jobs/${match.job.id}`}
                  className="btn-secondary shrink-0 px-3 py-1.5 text-xs"
                >
                  Review
                </Link>
              </div>
            </Card>
          ))}
        </ul>
      )}
    </section>
  );
}

function RecentActivity({ heading, count, data }: { heading: string; count: number; data: DashboardData }) {
  const events = data.events.slice(0, count);

  return (
    <div>
      <h2 className="mb-3 text-lg font-semibold text-ink">{heading}</h2>
      <Card className="divide-y divide-line">
        {events.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted">
            Your activity will appear here once your agents get to work.
          </p>
        ) : (
          events.map((event) => (
            <div key={event.id} className="flex gap-3 p-4">
              <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-raised">
                {event.type === 'scan' ? (
                  <Search className="h-3.5 w-3.5 text-brand-500" />
                ) : event.type === 'apply' ? (
                  <FolderTree className="h-3.5 w-3.5 text-success" />
                ) : event.type === 'prep' ? (
                  <TrendingUp className="h-3.5 w-3.5 text-brand-500" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5 text-muted" />
                )}
              </div>
              <div className="min-w-0">
                <p className="text-sm text-ink">{event.message}</p>
                <p className="mt-0.5 text-xs text-faint">{formatRelative(event.createdAt)}</p>
              </div>
            </div>
          ))
        )}
      </Card>
    </div>
  );
}

function Pipeline({ heading, data }: { heading: string; data: DashboardData }) {
  if (data.applicationCount === 0) return null;

  return (
    <Card className="p-4">
      <h3 className="mb-3 text-sm font-semibold text-ink">{heading}</h3>
      <ul className="space-y-2 text-sm">
        {[
          // Stage 13: cumulative reach from the outcome mart (METRIC_DICTIONARY.md
          // `sent` and `interviews`), not a snapshot of today's status.
          { label: 'Sent', value: data.submittedCount, status: 'submitted' },
          { label: 'Reached interview', value: data.interviewCount, status: 'interviewing' },
        ].map((row) => (
          <li key={row.label} className="flex items-center justify-between">
            <StatusBadge status={row.status} />
            <span className="font-semibold tabular-nums text-ink">{row.value}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Announcement({
  heading,
  body,
  tone,
  linkLabel,
  linkHref,
}: {
  heading: string;
  body?: string;
  tone: 'info' | 'success' | 'warning';
  linkLabel?: string;
  linkHref?: string;
}) {
  const tones = {
    info: { wrap: 'border-brand-500/40 bg-brand-500/5', icon: <Info className="h-5 w-5 text-brand-500" /> },
    success: { wrap: 'border-success/40 bg-success/5', icon: <CheckCircle2 className="h-5 w-5 text-success" /> },
    warning: { wrap: 'border-warning/40 bg-warning/5', icon: <AlertTriangle className="h-5 w-5 text-warning" /> },
  } as const;
  const t = tones[tone] ?? tones.info;

  return (
    <Card className={`mb-8 p-5 ${t.wrap}`}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0">{t.icon}</div>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-ink">{heading}</h2>
          {body && <p className="mt-1 text-sm text-muted">{body}</p>}
          {linkLabel && linkHref && (
            <Link href={linkHref} className="mt-2 inline-block text-sm font-semibold text-brand-500 hover:text-brand-600">
              {linkLabel} →
            </Link>
          )}
        </div>
      </div>
    </Card>
  );
}

// --- Registry --------------------------------------------------------------

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
const text = (v: unknown, fallback: string): string =>
  typeof v === 'string' && v.trim() ? v : fallback;

/**
 * Render one configured widget. Unknown block types render nothing rather
 * than crashing — a layout document written by a newer schema must never
 * take the dashboard down.
 */
export function renderDashboardWidget(widget: DashboardWidget, data: DashboardData): ReactElement | null {
  switch (widget.blockType) {
    case 'statsRow': {
      const stats = Array.isArray(widget.stats)
        ? (widget.stats as string[])
        : ['applications', 'agents', 'matches', 'interviewRate'];
      return <StatsRow key={widget.id} stats={stats} data={data} />;
    }
    case 'gettingStarted':
      return (
        <GettingStarted
          key={widget.id}
          heading={text(widget.heading, 'Create your first job agent')}
          body={text(
            widget.body,
            'Tell JobPilot which titles you want and where. Your agent will scan live postings and score each one against your resume.',
          )}
          ctaLabel={text(widget.ctaLabel, 'Create an agent')}
          data={data}
        />
      );
    case 'topMatches':
      return (
        <TopMatches
          key={widget.id}
          heading={text(widget.heading, 'Your best matches')}
          count={num(widget.count, 4)}
          data={data}
        />
      );
    case 'recentActivity':
      return (
        <RecentActivity
          key={widget.id}
          heading={text(widget.heading, 'Recent activity')}
          count={num(widget.count, 6)}
          data={data}
        />
      );
    case 'pipeline':
      return <Pipeline key={widget.id} heading={text(widget.heading, 'Pipeline')} data={data} />;
    case 'announcement':
      return (
        <Announcement
          key={widget.id}
          heading={text(widget.heading, '')}
          body={typeof widget.body === 'string' ? widget.body : undefined}
          tone={(widget.tone as 'info' | 'success' | 'warning') ?? 'info'}
          linkLabel={typeof widget.linkLabel === 'string' ? widget.linkLabel : undefined}
          linkHref={typeof widget.linkHref === 'string' ? widget.linkHref : undefined}
        />
      );
    default:
      return null;
  }
}

/** Which column each widget type belongs to in the two-column band. */
export function widgetColumn(blockType: string): 'main' | 'side' | 'full' {
  switch (blockType) {
    case 'topMatches':
      return 'main';
    case 'recentActivity':
    case 'pipeline':
      return 'side';
    default:
      return 'full';
  }
}
