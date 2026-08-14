import Link from 'next/link';
import { Download, Files } from 'lucide-react';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { formatCents } from '@/lib/billing/invoice';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { ExportButton } from '@/components/export-button';
import { DocumentLibrary } from './document-library';
import type { DocumentKind, DocumentRowView, KindOption } from './types';

export const metadata = { title: 'Documents' };
export const dynamic = 'force-dynamic';

/** Ceiling on how much history the library loads in one page. */
const APPLICATION_LIMIT = 200;
const INVOICE_LIMIT = 100;

/** Display order of the type filter, independent of how many of each exist. */
const KIND_ORDER: { value: DocumentKind; label: string }[] = [
  { value: 'resume', label: 'Tailored resumes' },
  { value: 'cover_letter', label: 'Cover letters' },
  { value: 'folder', label: 'Application folders' },
  { value: 'job_description', label: 'Job descriptions' },
  { value: 'interview_prep', label: 'Interview prep' },
  { value: 'master_resume', label: 'Master resume' },
  { value: 'invoice', label: 'Invoices' },
];

/**
 * Bulk exports of the underlying data.
 *
 * Distinct from the file list below: these are generated on request from the
 * live tables, so they always reflect the whole account rather than the rows
 * that happen to be on this page.
 */
const EXPORTS = [
  {
    endpoint: '/api/exports/applications',
    filename: 'jobpilot-applications',
    label: 'Applications',
    note: 'Every application with its status, score and dates.',
  },
  {
    endpoint: '/api/exports/matches',
    filename: 'jobpilot-matches',
    label: 'Job matches',
    note: 'Scored postings your agents surfaced.',
  },
  {
    endpoint: '/api/exports/analytics',
    filename: 'jobpilot-analytics',
    label: 'Analytics',
    note: 'Funnel, conversion rates and match quality.',
  },
  {
    endpoint: '/api/exports/invoices',
    filename: 'jobpilot-invoices',
    label: 'Invoices',
    note: 'Billing history for your accountant.',
  },
];

function dateLabel(value: Date): string {
  return value.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
}

export default async function DocumentsPage() {
  const user = await requireUser();

  const [applications, resumes, invoices] = await Promise.all([
    db.application.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: APPLICATION_LIMIT,
      select: {
        id: true,
        createdAt: true,
        appliedAt: true,
        folderPath: true,
        tailoredResume: true,
        coverLetter: true,
        job: { select: { title: true, company: true } },
        interviewPrep: { select: { id: true, createdAt: true, status: true } },
      },
    }),
    db.resume.findMany({ where: { userId: user.id }, orderBy: { updatedAt: 'desc' } }),
    db.invoice.findMany({
      where: { userId: user.id, number: { not: null } },
      orderBy: [{ issuedAt: 'desc' }, { createdAt: 'desc' }],
      take: INVOICE_LIMIT,
      select: {
        id: true,
        number: true,
        issuedAt: true,
        createdAt: true,
        planName: true,
        currency: true,
        totalCents: true,
      },
    }),
  ]);

  const rows: DocumentRowView[] = [];

  for (const resume of resumes) {
    rows.push({
      id: `resume-${resume.id}`,
      kind: 'master_resume',
      title: resume.label,
      context: 'The resume every application is tailored from',
      dateIso: resume.updatedAt.toISOString(),
      dateLabel: dateLabel(resume.updatedAt),
      formatLabel: 'In app',
      downloadUrl: null,
      viewUrl: '/dashboard/resume',
    });
  }

  for (const application of applications) {
    const at = application.appliedAt ?? application.createdAt;
    const iso = at.toISOString();
    const label = dateLabel(at);
    const context = `${application.job.company} · ${application.job.title}`;
    const files = `/api/applications/${application.id}/files`;

    // Only offer a file the download route can actually serve. It falls back to
    // the database copy when the folder is gone, so resume, cover letter and
    // job description are safe; the README and tailoring report exist on disk
    // only, and are reachable through the application folder instead.
    if (application.tailoredResume.trim()) {
      rows.push({
        id: `app-resume-${application.id}`,
        kind: 'resume',
        title: `Tailored resume — ${application.job.title}`,
        context,
        dateIso: iso,
        dateLabel: label,
        formatLabel: 'TXT',
        downloadUrl: `${files}/resume.txt`,
        viewUrl: null,
      });
    }

    if (application.coverLetter.trim()) {
      rows.push({
        id: `app-letter-${application.id}`,
        kind: 'cover_letter',
        title: `Cover letter — ${application.job.company}`,
        context,
        dateIso: iso,
        dateLabel: label,
        formatLabel: 'TXT',
        downloadUrl: `${files}/cover-letter.txt`,
        viewUrl: null,
      });
    }

    rows.push({
      id: `app-jd-${application.id}`,
      kind: 'job_description',
      title: `Job description — ${application.job.title}`,
      context: `${context} · as it appeared when you applied`,
      dateIso: iso,
      dateLabel: label,
      formatLabel: 'MD',
      downloadUrl: `${files}/job-description.md`,
      viewUrl: null,
    });

    if (application.folderPath) {
      rows.push({
        id: `app-folder-${application.id}`,
        kind: 'folder',
        title: `Application folder — ${application.job.company}`,
        context: `${context} · resume, letter, posting and tailoring report`,
        dateIso: iso,
        dateLabel: label,
        formatLabel: 'Folder',
        downloadUrl: null,
        viewUrl: `/dashboard/applications/${application.id}`,
      });
    }

    if (application.interviewPrep && application.interviewPrep.status === 'ready') {
      rows.push({
        id: `app-prep-${application.id}`,
        kind: 'interview_prep',
        title: `Interview prep — ${application.job.title}`,
        context,
        dateIso: application.interviewPrep.createdAt.toISOString(),
        dateLabel: dateLabel(application.interviewPrep.createdAt),
        formatLabel: 'In app',
        downloadUrl: null,
        // Prep is keyed by application id in the URL, not by its own id.
        viewUrl: `/dashboard/interview-prep/${application.id}`,
      });
    }
  }

  for (const invoice of invoices) {
    const at = invoice.issuedAt ?? invoice.createdAt;
    rows.push({
      id: `invoice-${invoice.id}`,
      kind: 'invoice',
      title: `Invoice ${invoice.number}`,
      context: `${invoice.planName || 'JobPilot'} · ${formatCents(invoice.totalCents, invoice.currency)}`,
      dateIso: at.toISOString(),
      dateLabel: dateLabel(at),
      formatLabel: 'PDF',
      downloadUrl: `/api/invoices/${invoice.id}/pdf`,
      viewUrl: null,
    });
  }

  rows.sort((a, b) => (a.dateIso < b.dateIso ? 1 : a.dateIso > b.dateIso ? -1 : 0));

  const kindOptions: KindOption[] = KIND_ORDER.map((entry) => ({
    value: entry.value,
    label: entry.label,
    count: rows.filter((row) => row.kind === entry.value).length,
  })).filter((option) => option.count > 0);

  return (
    <>
      <PageHeader
        title="Documents"
        description="Every file JobPilot has generated for you — tailored resumes, cover letters, application folders and invoices — in one place."
      />

      {rows.length === 0 ? (
        <EmptyState
          icon={<Files className="h-5 w-5" />}
          title="No documents yet"
          description="Save your resume, then apply to a role. JobPilot writes a tailored resume, a cover letter and a copy of the posting for every application, and they all land here."
          action={
            <Link href="/dashboard/resume" className="btn-primary">
              Build your resume
            </Link>
          }
        />
      ) : (
        <>
          <Card className="mb-6 p-5">
            <div className="mb-4 flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-500/10">
                <Download className="h-4 w-4 text-brand-500" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-ink">Export your data</h2>
                <p className="mt-1 text-sm text-muted">
                  Generated fresh from your whole account, as a spreadsheet or a formatted PDF.
                </p>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {EXPORTS.map((entry) => (
                <div
                  key={entry.endpoint}
                  className="flex flex-col justify-between gap-3 rounded-xl border border-line p-3"
                >
                  <div>
                    <p className="text-sm font-semibold text-ink">{entry.label}</p>
                    <p className="mt-0.5 text-xs text-muted">{entry.note}</p>
                  </div>
                  <ExportButton
                    endpoint={entry.endpoint}
                    filename={entry.filename}
                    label="Download"
                    className="self-start"
                  />
                </div>
              ))}
            </div>
          </Card>

          <DocumentLibrary rows={rows} kindOptions={kindOptions} />

          {applications.length >= APPLICATION_LIMIT && (
            <p className="mt-3 text-xs text-muted">
              Showing documents from your {APPLICATION_LIMIT} most recent applications. Use the
              applications export above for the complete list.
            </p>
          )}
        </>
      )}
    </>
  );
}
