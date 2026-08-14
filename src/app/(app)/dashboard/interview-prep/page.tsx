import Link from 'next/link';
import { MessagesSquare } from 'lucide-react';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { Card, EmptyState, PageHeader, StatusBadge, formatRelative } from '@/components/ui';
import { InterviewPrepButton } from '@/components/interview-prep-button';

export const metadata = { title: 'Interview prep' };
export const dynamic = 'force-dynamic';

export default async function InterviewPrepPage() {
  const user = await requireUser();

  const applications = await db.application.findMany({
    where: { userId: user.id, status: { in: ['submitted', 'interviewing', 'offer'] } },
    orderBy: { createdAt: 'desc' },
    include: { job: true, interviewPrep: true },
  });

  const ready = applications.filter((a) => a.interviewPrep);
  const pending = applications.filter((a) => !a.interviewPrep);

  return (
    <>
      <PageHeader
        title="Interview preparation"
        description="Likely questions, model answers and STAR stories built from your real experience — for any role you have applied to."
      />

      {applications.length === 0 ? (
        <EmptyState
          icon={<MessagesSquare className="h-5 w-5" />}
          title="Nothing to prepare for yet"
          description="Once you have applied to a few roles, come back here to build a preparation pack for each one."
          action={
            <Link href="/dashboard/jobs" className="btn-primary">
              Browse your job feed
            </Link>
          }
        />
      ) : (
        <div className="space-y-8">
          {ready.length > 0 && (
            <section>
              <h2 className="mb-3 text-lg font-semibold text-ink">Ready to review</h2>
              <ul className="space-y-3">
                {ready.map((application) => (
                  <Card as="li" key={application.id} className="p-4">
                    <Link
                      href={`/dashboard/interview-prep/${application.id}`}
                      className="flex items-center justify-between gap-4"
                    >
                      <div className="min-w-0">
                        <h3 className="truncate font-semibold text-ink">{application.job.title}</h3>
                        <p className="truncate text-sm text-muted">
                          {application.job.company} · prepared{' '}
                          {formatRelative(application.interviewPrep!.updatedAt)}
                        </p>
                      </div>
                      <span className="btn-secondary shrink-0 px-3 py-1.5 text-xs">Open pack</span>
                    </Link>
                  </Card>
                ))}
              </ul>
            </section>
          )}

          {pending.length > 0 && (
            <section>
              <h2 className="mb-3 text-lg font-semibold text-ink">Applications you could prepare for</h2>
              <ul className="space-y-3">
                {pending.map((application) => (
                  <Card as="li" key={application.id} className="p-4">
                    <div className="flex flex-wrap items-center justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <h3 className="truncate font-semibold text-ink">
                            {application.job.title}
                          </h3>
                          <StatusBadge status={application.status} />
                        </div>
                        <p className="truncate text-sm text-muted">{application.job.company}</p>
                      </div>
                      <div className="w-full sm:w-auto">
                        <InterviewPrepButton
                          applicationId={application.id}
                          label="Build prep pack"
                        />
                      </div>
                    </div>
                  </Card>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </>
  );
}
