import Link from 'next/link';
import { FolderTree, MapPin } from 'lucide-react';
import { requireTenant } from '@/lib/tenancy/request';
import {
  Card,
  EmptyState,
  PageHeader,
  ScoreRing,
  Stat,
  StatusBadge,
  formatRelative,
} from '@/components/ui';

export const metadata = { title: 'Applications' };
export const dynamic = 'force-dynamic';

export default async function ApplicationsPage() {
  const { user, run } = await requireTenant();

  const applications = await run((tx) =>
    tx.application.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      include: { job: true },
    }),
  );

  const submitted = applications.filter((a) => a.status === 'submitted').length;
  const interviewing = applications.filter((a) =>
    ['interviewing', 'offer'].includes(a.status),
  ).length;
  const needsAttention = applications.filter((a) => a.status === 'failed').length;

  return (
    <>
      <PageHeader
        title="Applications"
        description="Every application you have sent, with the exact documents that were submitted."
      />

      {applications.length === 0 ? (
        <EmptyState
          icon={<FolderTree className="h-5 w-5" />}
          title="No applications yet"
          description="Once you apply to jobs from your feed, each one appears here with its own folder containing the customized resume, cover letter and job description."
          action={
            <Link href="/dashboard/jobs" className="btn-primary">
              Browse your job feed
            </Link>
          }
        />
      ) : (
        <>
          <div className="mb-6 grid gap-4 sm:grid-cols-3">
            <Stat label="Submitted" value={submitted} tone="brand" />
            <Stat label="In interviews" value={interviewing} tone="success" />
            <Stat
              label="Needs attention"
              value={needsAttention}
              hint={needsAttention > 0 ? 'Apply manually with your tailored docs' : undefined}
            />
          </div>

          <ul className="space-y-3">
            {applications.map((application) => (
              <Card as="li" key={application.id} className="p-4">
                <Link
                  href={`/dashboard/applications/${application.id}`}
                  className="flex items-start gap-4"
                >
                  <ScoreRing score={application.matchScore} size={48} />

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-semibold text-ink">{application.job.title}</h2>
                      <StatusBadge status={application.status} />
                    </div>
                    <p className="text-sm text-muted">{application.job.company}</p>

                    <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-faint">
                      <span className="flex items-center gap-1">
                        <MapPin className="h-3 w-3" />
                        {application.job.location}
                      </span>
                      <span>
                        Applied{' '}
                        {application.appliedAt
                          ? formatRelative(application.appliedAt)
                          : formatRelative(application.createdAt)}
                      </span>
                      <span>ATS score {application.atsScore}%</span>
                    </div>

                    {application.failureReason && (
                      <p className="mt-2 text-xs text-warn">{application.failureReason}</p>
                    )}
                  </div>

                  <span className="btn-secondary shrink-0 px-3 py-1.5 text-xs">
                    <FolderTree className="h-3.5 w-3.5" />
                    Open folder
                  </span>
                </Link>
              </Card>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
