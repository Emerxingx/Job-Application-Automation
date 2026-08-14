import Link from 'next/link';
import { Search } from 'lucide-react';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { getQuota } from '@/lib/subscription';
import { parseJson } from '@/lib/types';
import { EmptyState, PageHeader } from '@/components/ui';
import { ScanButton } from '@/components/scan-button';
import { JobFeed, type JobFeedItem } from '@/components/job-feed';

export const metadata = { title: 'Job feed' };
export const dynamic = 'force-dynamic';

export default async function JobsPage() {
  const user = await requireUser();

  const [matches, quota, agentCount, appliedJobs] = await Promise.all([
    db.jobMatch.findMany({
      where: { agent: { userId: user.id }, status: { in: ['new', 'reviewed', 'queued'] } },
      orderBy: { matchScore: 'desc' },
      take: 100,
      include: { job: true, agent: { select: { id: true, name: true } } },
    }),
    getQuota(user.id),
    db.agent.count({ where: { userId: user.id } }),
    db.application.findMany({ where: { userId: user.id }, select: { jobId: true } }),
  ]);

  const appliedIds = new Set(appliedJobs.map((a) => a.jobId));

  const items: JobFeedItem[] = matches
    .filter((m) => !appliedIds.has(m.jobId))
    .map((m) => ({
      matchId: m.id,
      jobId: m.jobId,
      title: m.job.title,
      company: m.job.company,
      location: m.job.location,
      workMode: m.job.workMode,
      jobType: m.job.jobType,
      salaryMin: m.job.salaryMin,
      salaryMax: m.job.salaryMax,
      salaryCurrency: m.job.salaryCurrency,
      postedAt: m.job.postedAt.toISOString(),
      matchScore: m.matchScore,
      rationale: m.rationale,
      matchedKeywords: parseJson<string[]>(m.matchedKeywords, []),
      missingKeywords: parseJson<string[]>(m.missingKeywords, []),
      agentName: m.agent.name,
    }));

  return (
    <>
      <PageHeader
        title="Job feed"
        description="Live postings your agents found, scored against your resume. Pick what to apply to — or apply to all of them."
        action={<ScanButton label="Refresh feed" variant="secondary" />}
      />

      {items.length === 0 ? (
        <EmptyState
          icon={<Search className="h-5 w-5" />}
          title={agentCount === 0 ? 'No agents yet' : 'No new matches'}
          description={
            agentCount === 0
              ? 'Create a job agent to start scanning live postings for the titles you want.'
              : 'Your agents have no unreviewed matches right now. Run a scan to pull the latest postings.'
          }
          action={
            agentCount === 0 ? (
              <Link href="/dashboard/agents/new" className="btn-primary">
                Create an agent
              </Link>
            ) : (
              <ScanButton label="Run a scan" />
            )
          }
        />
      ) : (
        <JobFeed items={items} remaining={quota?.remaining ?? 0} />
      )}
    </>
  );
}
