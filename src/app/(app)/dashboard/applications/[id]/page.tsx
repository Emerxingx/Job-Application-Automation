import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  Building2,
  Calendar,
  CheckCircle2,
  Download,
  ExternalLink,
  FileText,
  MapPin,
  Wallet,
} from 'lucide-react';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { listFolder } from '@/lib/storage';
import { parseJson } from '@/lib/types';
import type { TailoringNotes } from '@/lib/types';
import { Card, ScoreRing, StatusBadge, formatSalary } from '@/components/ui';
import { ApplicationStatusControl } from '@/components/application-status';
import { InterviewPrepButton } from '@/components/interview-prep-button';
import { AssistedApply, type AssistedField } from '@/components/assisted-apply';
import { atsDisplayName } from '@/lib/providers/apply';
import type { AtsVendor } from '@/lib/providers/apply';

export const metadata = { title: 'Application' };
export const dynamic = 'force-dynamic';

export default async function ApplicationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;

  const application = await db.application.findFirst({
    where: { id, userId: user.id },
    include: { job: true, interviewPrep: true },
  });
  if (!application) notFound();

  const assistedFields = parseJson<AssistedField[]>(application.assistedFields, []);
  const notes = parseJson<TailoringNotes>(application.tailoringNotes, {
    summaryRewritten: false,
    bulletsAdjusted: 0,
    skillsReordered: false,
    keywordsInjected: [],
    atsScore: 0,
    changes: [],
  });

  // Nothing has reached the employer until the applicant confirms, so the copy
  // on this page must not describe the documents as sent before then.
  const sent = application.status !== 'ready_to_submit';

  const files = await listFolder(user.id, application.folderPath);
  // Fall back to the database copies when the filesystem folder is unavailable.
  const fileList = files.length
    ? files
    : [
        {
          name: 'resume.txt',
          size: application.tailoredResume.length,
          description: sent ? 'The customized resume that was submitted' : 'The customized resume, ready to send',
        },
        {
          name: 'cover-letter.txt',
          size: application.coverLetter.length,
          description: sent ? 'The cover letter that was submitted' : 'The cover letter, ready to send',
        },
        {
          name: 'job-description.md',
          size: application.job.description.length,
          description: sent ? 'The posting as it appeared when you applied' : 'The posting as it appeared when this was prepared',
        },
      ];

  return (
    <>
      <Link
        href="/dashboard/applications"
        className="mb-5 inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-ink"
      >
        <ArrowLeft className="h-4 w-4" />
        All applications
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <ScoreRing score={application.matchScore} />
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-ink">{application.job.title}</h1>
            <p className="mt-0.5 text-muted">{application.job.company}</p>
            <div className="mt-2">
              <StatusBadge status={application.status} />
            </div>
          </div>
        </div>
        {/* Outcome tracking only applies once the application has actually been
            sent. While it is awaiting confirmation, the assisted panel below
            owns the next action. */}
        {sent && (
          <ApplicationStatusControl applicationId={application.id} status={application.status} />
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {/* Assisted apply — shown until the applicant confirms they sent it */}
          {application.status === 'ready_to_submit' && assistedFields.length > 0 && (
            <AssistedApply
              applicationId={application.id}
              applyUrl={application.job.applyUrl}
              atsName={application.atsVendor ? atsDisplayName(application.atsVendor as AtsVendor) : undefined}
              fields={assistedFields}
            />
          )}

          {/* Folder */}
          <Card className="p-5">
            <h2 className="mb-1 font-semibold text-ink">Application folder</h2>
            <p className="mb-4 text-sm text-muted">
              {application.status === 'ready_to_submit'
                ? 'Everything prepared for this role, ready to send.'
                : 'Everything submitted on your behalf, exactly as it was sent.'}
            </p>

            <ul className="divide-y divide-line">
              {fileList.map((file) => (
                <li key={file.name} className="flex items-center gap-3 py-3">
                  <FileText className="h-4 w-4 shrink-0 text-faint" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink">{file.name}</p>
                    <p className="truncate text-xs text-muted">{file.description}</p>
                  </div>
                  <a
                    href={`/api/applications/${application.id}/files/${encodeURIComponent(file.name)}`}
                    className="btn-ghost shrink-0 px-2.5 py-1.5 text-xs"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Download
                  </a>
                </li>
              ))}
            </ul>

            {application.folderPath && (
              <p className="mt-3 border-t border-line pt-3 font-mono text-xs text-faint">
                {application.folderPath}
              </p>
            )}
          </Card>

          {/* Tailoring report */}
          <Card className="p-5">
            <div className="mb-4 flex items-baseline justify-between">
              <h2 className="font-semibold text-ink">How your resume was tailored</h2>
              <span className="text-sm font-semibold text-success">
                ATS score {notes.atsScore}%
              </span>
            </div>

            <ul className="space-y-2.5">
              {notes.changes.map((change, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-muted">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                  <span>{change}</span>
                </li>
              ))}
            </ul>

            {notes.keywordsInjected.length > 0 && (
              <div className="mt-4 border-t border-line pt-4">
                <p className="mb-2 text-xs font-medium text-faint">Keywords surfaced</p>
                <div className="flex flex-wrap gap-1.5">
                  {notes.keywordsInjected.map((k) => (
                    <span key={k} className="chip bg-brand-500/10 text-brand-600">
                      {k}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <p className="mt-4 rounded-xl bg-raised p-3 text-xs text-muted">
              Tailoring only rephrases and reorders experience already in your resume. No employer,
              title, date or credential is ever invented.
            </p>
          </Card>

          {/* Submitted resume */}
          <Card className="p-5">
            <h2 className="mb-3 font-semibold text-ink">
              {sent ? 'Resume submitted' : 'Resume prepared'}
            </h2>
            <div className="scroll-x max-h-96 overflow-y-auto rounded-xl bg-raised p-4">
              <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-muted">
                {application.tailoredResume}
              </pre>
            </div>
          </Card>

          {/* Cover letter */}
          <Card className="p-5">
            <h2 className="mb-3 font-semibold text-ink">
              {sent ? 'Cover letter submitted' : 'Cover letter prepared'}
            </h2>
            <div className="scroll-x max-h-96 overflow-y-auto rounded-xl bg-raised p-4">
              <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-muted">
                {application.coverLetter}
              </pre>
            </div>
          </Card>
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          <Card className="p-5">
            <h2 className="mb-3 font-semibold text-ink">Role details</h2>
            <dl className="space-y-3 text-sm">
              {[
                { icon: Building2, label: 'Company', value: application.job.company },
                {
                  icon: MapPin,
                  label: 'Location',
                  value: `${application.job.location} · ${application.job.workMode}`,
                },
                {
                  icon: Wallet,
                  label: 'Compensation',
                  value: formatSalary(
                    application.job.salaryMin,
                    application.job.salaryMax,
                    application.job.salaryCurrency,
                  ),
                },
                {
                  icon: Calendar,
                  label: 'Posted',
                  value: application.job.postedAt.toLocaleDateString('en-CA', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                  }),
                },
                {
                  icon: Calendar,
                  label: 'Applied',
                  value: application.appliedAt
                    ? application.appliedAt.toLocaleDateString('en-CA', {
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric',
                      })
                    : 'Not submitted',
                },
              ].map((row) => (
                <div key={row.label} className="flex gap-2.5">
                  <row.icon className="mt-0.5 h-4 w-4 shrink-0 text-faint" />
                  <div className="min-w-0">
                    <dt className="text-xs text-faint">{row.label}</dt>
                    <dd className="text-ink">{row.value}</dd>
                  </div>
                </div>
              ))}
              {application.job.nocCode && (
                <div className="flex gap-2.5">
                  <FileText className="mt-0.5 h-4 w-4 shrink-0 text-faint" />
                  <div>
                    <dt className="text-xs text-faint">NOC code</dt>
                    <dd className="text-ink">{application.job.nocCode}</dd>
                  </div>
                </div>
              )}
            </dl>

            {application.job.applyUrl && (
              <a
                href={application.job.applyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary mt-4 w-full text-xs"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                View original posting
              </a>
            )}
          </Card>

          {/* Interview prep */}
          <Card className="p-5">
            <h2 className="font-semibold text-ink">Interview preparation</h2>
            {application.interviewPrep ? (
              <>
                <p className="mt-1.5 text-sm text-muted">
                  Your prep pack is ready — questions, STAR stories and company research.
                </p>
                <Link
                  href={`/dashboard/interview-prep/${application.id}`}
                  className="btn-primary mt-4 w-full"
                >
                  Open prep pack
                </Link>
              </>
            ) : (
              <>
                <p className="mt-1.5 text-sm text-muted">
                  Would you like to prepare for this interview? We will build likely questions,
                  model answers and STAR stories from your real experience.
                </p>
                <div className="mt-4">
                  <InterviewPrepButton applicationId={application.id} />
                </div>
              </>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
