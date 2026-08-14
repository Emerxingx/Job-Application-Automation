import Link from 'next/link';
import {
  ArrowRight,
  FolderTree,
  Radar,
  Search,
  Sparkles,
  TrendingUp,
} from 'lucide-react';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { getQuota } from '@/lib/subscription';
import {
  Card,
  EmptyState,
  PageHeader,
  ScoreRing,
  Stat,
  StatusBadge,
  formatRelative,
} from '@/components/ui';
import { ScanButton } from '@/components/scan-button';

export const metadata = { title: 'Overview' };
export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const user = await requireUser();

  const [quota, agents, applications, topMatches, events, submittedCount, interviewCount] =
    await Promise.all([
      getQuota(user.id),
      db.agent.count({ where: { userId: user.id } }),
      db.application.count({ where: { userId: user.id } }),
      db.jobMatch.findMany({
        where: { agent: { userId: user.id }, status: 'new' },
        orderBy: { matchScore: 'desc' },
        take: 4,
        include: { job: true },
      }),
      db.activityEvent.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 6,
      }),
      db.application.count({ where: { userId: user.id, status: 'submitted' } }),
      db.application.count({
        where: { userId: user.id, status: { in: ['interviewing', 'offer'] } },
      }),
    ]);

  const firstName = user.fullName.split(' ')[0];
  const responseRate = applications > 0 ? Math.round((interviewCount / applications) * 100) : 0;

  return (
    <>
      <PageHeader
        title={`Welcome back, ${firstName}`}
        description="Here is where your search stands today."
        action={<ScanButton label="Scan all agents" />}
      />

      {/* Stats */}
      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Applications sent"
          value={submittedCount}
          hint={quota ? `${quota.remaining} left this cycle` : undefined}
          tone="brand"
        />
        <Stat label="Active agents" value={agents} hint="Scanning live postings" />
        <Stat
          label="New matches"
          value={topMatches.length ? `${topMatches.length}+` : 0}
          hint="Waiting for your review"
        />
        <Stat
          label="Interview rate"
          value={`${responseRate}%`}
          hint={`${interviewCount} moved forward`}
          tone={responseRate > 0 ? 'success' : 'default'}
        />
      </div>

      {/* Getting started, only while the account is empty */}
      {agents === 0 && (
        <Card className="mb-8 border-brand-500/40 bg-brand-500/5 p-6">
          <div className="flex items-start gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-500/10">
              <Sparkles className="h-5 w-5 text-brand-500" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold text-ink">Create your first job agent</h2>
              <p className="mt-1 text-sm text-muted">
                Tell JobPilot which titles you want and where. Your agent will scan live postings
                and score each one against your resume.
              </p>
              <Link href="/dashboard/agents/new" className="btn-primary mt-4">
                Create an agent
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Top matches */}
        <section className="lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-ink">Your best matches</h2>
            <Link
              href="/dashboard/jobs"
              className="text-sm font-medium text-brand-500 hover:text-brand-600"
            >
              View all
            </Link>
          </div>

          {topMatches.length === 0 ? (
            <EmptyState
              icon={<Search className="h-5 w-5" />}
              title="No matches yet"
              description={
                agents === 0
                  ? 'Create a job agent and run a scan to see live postings scored against your resume.'
                  : 'Run a scan to pull the latest live postings for your agents.'
              }
              action={
                agents === 0 ? (
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
              {topMatches.map((match) => (
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

        {/* Activity */}
        <section>
          <h2 className="mb-3 text-lg font-semibold text-ink">Recent activity</h2>
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

          {applications > 0 && (
            <Card className="mt-4 p-4">
              <h3 className="mb-3 text-sm font-semibold text-ink">Pipeline</h3>
              <ul className="space-y-2 text-sm">
                {[
                  { label: 'Submitted', value: submittedCount, status: 'submitted' },
                  { label: 'In interviews', value: interviewCount, status: 'interviewing' },
                ].map((row) => (
                  <li key={row.label} className="flex items-center justify-between">
                    <StatusBadge status={row.status} />
                    <span className="font-semibold tabular-nums text-ink">{row.value}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </section>
      </div>
    </>
  );
}
