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
import { requireTenant } from '@/lib/tenancy/request';
import { listFolder } from '@/lib/storage';
import { parseJson } from '@/lib/types';
import type { TailoringNotes } from '@/lib/types';
import { Card, ScoreRing, StatusBadge, formatSalary } from '@/components/ui';
import { ApplicationStatusControl } from '@/components/application-status';
import { InterviewPrepButton } from '@/components/interview-prep-button';
import { AssistedApply, type AssistedField, type AssistedQuestion } from '@/components/assisted-apply';
import { ApplicationDocuments, type DocumentVersionView } from '@/components/application-documents';
import { ApplicationMessages } from '@/components/application-messages';
import { KIND_LABELS, MESSAGE_KINDS, type DocumentKind } from '@/lib/documents/kinds';
import { folderInclude } from '@/lib/applications/service';
import { folderCompleteness } from '@/lib/applications/folder';
import { ApplicationFolder } from '@/components/application-folder';
import { ApplicationCommunications, type EventView, type ThreadView } from '@/components/application-communications';
import type { ApplicationStatus } from '@/lib/types';
import { atsDisplayName } from '@/lib/providers/apply';
import type { AtsVendor } from '@/lib/providers/apply';

export const metadata = { title: 'Application' };
export const dynamic = 'force-dynamic';

export default async function ApplicationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { user, run } = await requireTenant();
  const { id } = await params;

  const application = await run((tx) =>
    tx.application.findFirst({
      where: { id, userId: user.id },
      include: folderInclude(),
    }),
  );
  if (!application) notFound();
  // Stage 11: threads the engine was not sure about, offered for this folder (best guess or rival) — never filed without the applicant.
  const suggestions = await run((tx) => tx.emailThread.findMany({ where: { userId: user.id, associationStatus: 'pending', OR: [{ applicationId: application.id }, { rivalApplicationId: application.id }] }, orderBy: { lastMessageAt: 'desc' } }));
  const eventSuggestions = await run((tx) => tx.calendarEventRef.findMany({ where: { userId: user.id, associationStatus: 'pending', applicationId: application.id }, orderBy: { startsAt: 'asc' } }));

  const assistedFields = parseJson<AssistedField[]>(application.assistedFields, []);
  // Stage 12: the question bank as prepared for this application; a `never` entry carries no value by construction.
  const preparedQuestions = parseJson<AssistedQuestion[]>(application.preparedQuestions, []);
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

  // Stage 09: the versioned files (TXT, PDF, DOCX) with their hashes and ATS
  // reports, and the messages drafted for this application. Dates are
  // formatted here so the client component renders the same string twice.
  const messageKinds = new Set<string>(MESSAGE_KINDS);
  const documentViews: DocumentVersionView[] = application.documents
    .filter((d) => !messageKinds.has(d.kind))
    .map((d) => ({
      id: d.id,
      kind: d.kind,
      label: KIND_LABELS[d.kind as DocumentKind] ?? d.kind,
      format: d.format,
      version: d.version,
      status: d.status,
      sizeBytes: d.sizeBytes,
      contentHash: d.contentHash,
      atsOk: (() => {
        try {
          const report = JSON.parse(d.atsReport) as { ok?: boolean };
          return typeof report.ok === 'boolean' ? report.ok : null;
        } catch {
          return null;
        }
      })(),
      createdLabel: d.createdAt.toLocaleString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    }));
  const messageViews = application.documents
    .filter((d) => messageKinds.has(d.kind))
    .map((d) => ({ id: d.id, kind: d.kind, version: d.version, createdLabel: d.createdAt.toLocaleString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }));

  // Stage 10: the folder — timeline, people, interviews, assessments,
  // follow-ups, notes, offer and outcome — and whether it answers "what was
  // sent, to whom, when, how, and what happened" on its own.
  const fmt = (d: Date) => d.toLocaleString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const fmtDay = (d: Date) => d.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
  const completeness = folderCompleteness({
    status: application.status as ApplicationStatus,
    appliedAt: application.appliedAt,
    applyChannel: application.applyChannel,
    confirmation: application.confirmation,
    company: application.job.company,
    sealedDocuments: application.documents.filter((d) => d.status === 'submitted').length,
    hasTextCopies: Boolean(application.tailoredResume.trim() || application.coverLetter.trim()),
    contacts: application.contacts.length,
    historyEntries: application.statusHistory.length,
    interviews: application.interviews.length,
    assessments: application.assessments.length,
    followUps: application.followUps.length,
    outcome: application.outcome,
    respondedAt: application.respondedAt,
  });
  const threadView = (t: (typeof application.emailThreads)[number]): ThreadView => ({ id: t.id, subject: t.subject, from: t.fromAddress, lastLabel: fmt(t.lastMessageAt), confidence: t.confidence, status: t.associationStatus, signals: parseJson<{ name: string }[]>(t.signals, []).map((s) => s.name), interview: t.interviewDetected, offer: t.offerDetected });
  const eventView = (e: (typeof application.calendarEvents)[number]): EventView => ({ id: e.id, title: e.title, organiser: e.organiser, whenLabel: fmt(e.startsAt), confidence: e.confidence, status: e.associationStatus });
  const eventViews: EventView[] = application.calendarEvents.map(eventView);
  const folderProps = {
    applicationId: application.id,
    status: application.status,
    outcome: application.outcome,
    rejectionReason: application.rejectionReason,
    offer: {
      receivedLabel: application.offerReceivedAt ? fmtDay(application.offerReceivedAt) : null,
      deadlineLabel: application.offerDeadline ? fmtDay(application.offerDeadline) : null,
      salaryMin: application.offerSalaryMin,
      salaryMax: application.offerSalaryMax,
      currency: application.offerCurrency,
      decision: application.offerDecision,
    },
    history: application.statusHistory.map((h) => ({ id: h.id, fromStatus: h.fromStatus, toStatus: h.toStatus, actor: h.actor, source: h.source, reason: h.reason, atLabel: fmt(h.at) })),
    contacts: application.contacts.map((c) => ({ id: c.id, role: c.role, name: c.name, email: c.email, phone: c.phone, organisation: c.organisation, notes: c.notes })),
    interviews: application.interviews.map((i) => ({ id: i.id, kind: i.kind, scheduledLabel: fmt(i.scheduledAt), scheduledIso: i.scheduledAt.toISOString(), location: i.location, interviewers: parseJson<string[]>(i.interviewers, []), outcome: i.outcome, result: i.result, notes: i.notes })),
    assessments: application.assessments.map((a) => ({ id: a.id, kind: a.kind, dueLabel: a.dueAt ? fmt(a.dueAt) : null, submittedLabel: a.submittedAt ? fmt(a.submittedAt) : null, result: a.result, notes: a.notes })),
    followUps: application.followUps.map((f) => ({ id: f.id, dueLabel: fmtDay(f.dueAt), doneLabel: f.doneAt ? fmtDay(f.doneAt) : null, channel: f.channel, note: f.note, documentVersionId: f.documentVersionId })),
    notes: application.crmNotes.map((n) => ({ id: n.id, body: n.body, atLabel: fmt(n.createdAt) })),
    messages: messageViews.map((m) => ({ id: m.id, label: `${KIND_LABELS[m.kind as DocumentKind] ?? m.kind} v${m.version}` })),
    answers: completeness.answers,
  };
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
              questions={preparedQuestions}
              atsSubmittable={application.atsSubmittable}
              mode={application.applicationMode}
              mappingVersion={application.fieldMappingVersion}
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

          {/* Stage 09: versioned files and drafted messages */}
          <ApplicationDocuments documents={documentViews} sealed={sent} />
          <ApplicationMessages applicationId={application.id} existing={messageViews} />
          <ApplicationFolder {...folderProps} />
          <ApplicationCommunications applicationId={application.id} threads={application.emailThreads.map(threadView)} suggestions={suggestions.map(threadView)} events={eventViews} eventSuggestions={eventSuggestions.map(eventView)} />

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
