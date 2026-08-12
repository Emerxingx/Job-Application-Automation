import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Calendar, ExternalLink, MapPin, Wallet } from 'lucide-react';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { getQuota } from '@/lib/subscription';
import { parseJson } from '@/lib/types';
import type { ScoreBreakdown } from '@/lib/types';
import { Card, ScoreRing, formatRelative, formatSalary, scoreTone } from '@/components/ui';
import { ApplyOneButton } from '@/components/apply-one-button';

export const metadata = { title: 'Job details' };
export const dynamic = 'force-dynamic';

const BREAKDOWN_LABELS: Record<keyof ScoreBreakdown, string> = {
  skills: 'Skills overlap',
  experience: 'Years of experience',
  keywords: 'Keyword density',
  seniority: 'Seniority alignment',
  location: 'Location fit',
};

export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  const job = await db.job.findUnique({ where: { id } });
  if (!job) notFound();

  const [match, application, quota] = await Promise.all([
    db.jobMatch.findFirst({
      where: { jobId: id, agent: { userId: user.id } },
      orderBy: { matchScore: 'desc' },
    }),
    db.application.findUnique({ where: { userId_jobId: { userId: user.id, jobId: id } } }),
    getQuota(user.id),
  ]);

  const breakdown = parseJson<ScoreBreakdown>(match?.scoreBreakdown, {
    skills: 0,
    experience: 0,
    keywords: 0,
    location: 0,
    seniority: 0,
  });
  const matched = parseJson<string[]>(match?.matchedKeywords, []);
  const missing = parseJson<string[]>(match?.missingKeywords, []);
  const requirements = parseJson<string[]>(job.requirements, []);

  return (
    <>
      <Link
        href="/dashboard/jobs"
        className="mb-5 inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-ink"
      >
        <ArrowLeft className="h-4 w-4" />
        Job feed
      </Link>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card className="p-6">
            <h1 className="text-2xl font-bold tracking-tight text-ink">{job.title}</h1>
            <p className="mt-1 text-lg text-muted">{job.company}</p>

            <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted">
              <span className="flex items-center gap-1.5">
                <MapPin className="h-4 w-4 text-faint" />
                {job.location} · {job.workMode}
              </span>
              <span className="flex items-center gap-1.5">
                <Wallet className="h-4 w-4 text-faint" />
                {formatSalary(job.salaryMin, job.salaryMax, job.salaryCurrency)}
              </span>
              <span className="flex items-center gap-1.5">
                <Calendar className="h-4 w-4 text-faint" />
                Posted {formatRelative(job.postedAt)}
              </span>
            </div>

            <div className="mt-4 flex flex-wrap gap-1.5">
              <span className="chip">{job.jobType.replace(/_/g, ' ')}</span>
              {job.nocCode && <span className="chip">NOC {job.nocCode}</span>}
            </div>
          </Card>

          <Card className="p-6">
            <h2 className="mb-4 font-semibold text-ink">Job description</h2>
            <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-muted">
              {job.description}
            </pre>
          </Card>

          {requirements.length > 0 && (
            <Card className="p-6">
              <h2 className="mb-4 font-semibold text-ink">Requirements</h2>
              <ul className="space-y-2">
                {requirements.map((r, i) => (
                  <li key={i} className="flex items-start gap-2.5 text-sm text-muted">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />
                    <span>{r}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {match && (
            <Card className="p-5">
              <div className="flex items-center gap-4">
                <ScoreRing score={match.matchScore} size={64} />
                <div>
                  <p className={`font-semibold ${scoreTone(match.matchScore).text}`}>
                    {scoreTone(match.matchScore).label} fit
                  </p>
                  <p className="text-xs text-muted">Predicted screening success</p>
                </div>
              </div>

              <p className="mt-4 text-sm leading-relaxed text-muted">{match.rationale}</p>

              <div className="mt-5 space-y-3 border-t border-line pt-4">
                {(Object.keys(BREAKDOWN_LABELS) as (keyof ScoreBreakdown)[]).map((key) => (
                  <div key={key}>
                    <div className="mb-1 flex items-baseline justify-between text-xs">
                      <span className="text-muted">{BREAKDOWN_LABELS[key]}</span>
                      <span className="font-semibold tabular-nums text-ink">{breakdown[key]}%</span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-raised">
                      <div
                        className="h-full rounded-full bg-brand-500"
                        style={{ width: `${breakdown[key]}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {(matched.length > 0 || missing.length > 0) && (
            <Card className="p-5">
              <h2 className="mb-3 font-semibold text-ink">Keyword analysis</h2>
              {matched.length > 0 && (
                <>
                  <p className="mb-2 text-xs font-medium text-success">You match these</p>
                  <div className="mb-4 flex flex-wrap gap-1.5">
                    {matched.map((k) => (
                      <span key={k} className="chip bg-success/10 text-success">
                        {k}
                      </span>
                    ))}
                  </div>
                </>
              )}
              {missing.length > 0 && (
                <>
                  <p className="mb-2 text-xs font-medium text-faint">Named but not evidenced</p>
                  <div className="flex flex-wrap gap-1.5">
                    {missing.map((k) => (
                      <span key={k} className="chip">
                        {k}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </Card>
          )}

          <Card className="p-5">
            {application ? (
              <>
                <p className="text-sm font-semibold text-ink">You already applied</p>
                <p className="mt-1 text-sm text-muted">
                  Applied{' '}
                  {application.appliedAt
                    ? formatRelative(application.appliedAt)
                    : formatRelative(application.createdAt)}
                  .
                </p>
                <Link
                  href={`/dashboard/applications/${application.id}`}
                  className="btn-secondary mt-4 w-full"
                >
                  View application folder
                </Link>
              </>
            ) : (
              <>
                <p className="text-sm font-semibold text-ink">Apply to this role</p>
                <p className="mt-1 text-sm text-muted">
                  Your resume will be rewritten for this posting and filed with a cover letter.
                </p>
                <div className="mt-4">
                  <ApplyOneButton jobId={job.id} disabled={!quota?.canApply} />
                </div>
                {!quota?.canApply && (
                  <p className="mt-2 text-xs text-warn">
                    You have used all your applications this cycle.{' '}
                    <Link href="/dashboard/billing" className="font-semibold underline">
                      Upgrade
                    </Link>{' '}
                    for more.
                  </p>
                )}
              </>
            )}

            {job.applyUrl && (
              <a
                href={job.applyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-ghost mt-2 w-full text-xs"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                View original posting
              </a>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
