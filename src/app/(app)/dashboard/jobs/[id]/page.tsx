import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Calendar, ExternalLink, MapPin, Wallet } from 'lucide-react';
import { requireTenant } from '@/lib/tenancy/request';
import { sourceNamesFor } from '@/lib/connectors/registry';
import { eligibilityForPage } from '@/lib/eligibility/page';
import { EligibilityPanel } from '@/components/eligibility-panel';
import { CredentialWhatIf } from '@/components/credential-whatif';
import { datasetFacts, isServable } from '@/lib/career/service';
import { quantityFor } from '@/lib/entitlements/service';
import { attributionFor } from '@/lib/taxonomy/datasets';
import { getQuota } from '@/lib/subscription';
import { parseJson } from '@/lib/types';
import type { ScoreBreakdown } from '@/lib/types';
import { Card, ScoreRing, formatRelative, formatSalary, scoreTone } from '@/components/ui';
import { ApplyOneButton } from '@/components/apply-one-button';
import { ApplyThroughPlatform } from '@/components/apply-through-platform';
import { db } from '@/lib/db';
import { EMPLOYER_SOURCE_KEY } from '@/lib/connectors/employer';

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
  const { user, run } = await requireTenant();
  const { id } = await params;

  // Job is reference data, readable on the tenant path; the match and the
  // application are the user's own rows.
  const [loaded, quota] = await Promise.all([
    run(async (tx) => {
      // Provenance is reference data the tenant may read; the source REGISTER
      // is system-only, so its names are resolved below, outside the tenant
      // transaction (an include here would return no rows and throw).
      const job = await tx.job.findUnique({ where: { id }, include: { occupation: { include: { labels: true, codes: true } }, provenance: { orderBy: { firstSeenAt: 'asc' } } } });
      if (!job) return null;
      const [match, application] = await Promise.all([
        tx.jobMatch.findFirst({
          where: { jobId: id, agent: { userId: user.id } },
          orderBy: { matchScore: 'desc' },
          // Stage 08: the score's dimensions, each with its cited evidence.
          include: { dimensions: { orderBy: { contribution: 'desc' } } },
        }),
        tx.application.findUnique({ where: { userId_jobId: { userId: user.id, jobId: id } } }),
      ]);
      // The claims cited by the dimensions (the candidate's own approved evidence).
      const citedIds = [...new Set((match?.dimensions ?? []).flatMap((d) => parseJson<string[]>(d.evidenceIds, [])))];
      const cited = citedIds.length ? await tx.careerEvidence.findMany({ where: { id: { in: citedIds }, userId: user.id }, select: { id: true, claim: true } }) : [];
      return { job, match, application, cited };
    }),
    getQuota(user.id),
  ]);
  if (!loaded) notFound();
  const { job, match, application, cited } = loaded;
  const claimById = new Map(cited.map((c) => [c.id, c.claim]));
  // Stage 07: the eligibility verdict, from the store when current, else
  // evaluated now (the facts read on the tenant path and audited).
  const eligibility = await eligibilityForPage(user.id, job, run);
  // The dataset register is system-only; this reads the one column a page needs.
  const attribution = await attributionFor(job.occupationId);
  // Stage 16 (ADR-0031): the credentials the posting's occupation lists under a
  // recorded licence, for the "what if I held it?" comparison in the sidebar.
  // (`TaxonomyDataset` is system-only, so the licence state is read through
  // `datasetFacts()` on the system client, never as a relation on the tenant path.)
  // Only for a person whose plan includes the analysis at all (the route refuses the rest).
  const occupationCredentials = job.occupationId && (await run((tx) => quantityFor(tx, user.id, 'career_transition_per_month'))) > 0
    ? await (async () => {
        const facts = await datasetFacts();
        const rows = await run((tx) =>
          tx.occupationCredential.findMany({
            where: { occupationId: job.occupationId! },
            include: { credential: { select: { id: true, name: true, recognition: true, datasetId: true } } },
            orderBy: [{ requirement: 'asc' }, { credential: { name: 'asc' } }],
          }),
        );
        return rows.filter((r) => isServable(r.credential.datasetId, facts));
      })()
    : [];
  // Likewise the source register: display names only, keyed by id.
  const sourceNames = await sourceNamesFor(job.provenance.map((p) => p.sourceId));
  // Stage 18: a first-party posting is applied to HERE. The requisition is the
  // employer's row (org-scoped; the candidate cannot read it on their tenant
  // path), so its status and the candidate's own submission are read on the
  // system client - filtered by this job and this user, nothing more.
  const firstParty =
    job.source === EMPLOYER_SOURCE_KEY
      ? await db.requisition.findUnique({ where: { jobId: job.id }, select: { id: true, status: true, submissions: { where: { candidateUserId: user.id }, select: { stage: true } } } })
      : null;

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
  // Stage 08: HOW each skill matched (exactly, or through the equivalence
  // map) and whether a missing one was a requirement or a nice-to-have, from
  // the skills dimension. Rows written before the labels existed carry plain
  // strings and simply show no label.
  const skillsDim = match?.dimensions.find((d) => d.dimension === 'skills');
  const semanticVia = new Map<string, string>();
  for (const m of parseJson<unknown[]>(skillsDim?.matched, [])) {
    if (m && typeof m === 'object' && (m as { how?: string }).how === 'semantic') semanticVia.set((m as { term: string }).term, (m as { via?: string }).via ?? '');
  }
  const preferredMissing = new Set<string>();
  for (const m of parseJson<unknown[]>(skillsDim?.missing, [])) {
    if (m && typeof m === 'object' && (m as { level?: string }).level === 'preferred') preferredMissing.add((m as { term: string }).term);
  }

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

            {/*
             * Stage 06: closure is a statement a source made, never inferred
             * from silence; `unknown` means the source could not say.
             */}
            {job.activeState === 'closed' && (
              <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                This posting is closed{job.closedAt ? ` (detected ${formatRelative(job.closedAt)})` : ''}. It stays here for your records; it is no longer in your feed.
              </p>
            )}
            {job.activeState === 'unknown' && (
              <p className="mt-3 text-xs text-faint">The source has not confirmed whether this posting is still open.</p>
            )}
            <div className="mt-4 flex flex-wrap gap-1.5">
              <span className="chip">{job.jobType.replace(/_/g, ' ')}</span>
              {job.sponsorship !== 'unknown' && <span className="chip">{job.sponsorship === 'offered' ? 'Sponsorship stated' : 'No sponsorship stated'}</span>}
              {job.workAuthorization && <span className="chip">{job.workAuthorization.replace(/_/g, ' ')}</span>}
              {/*
               * A NOC code is only certain when the spine classified the title
               * with high confidence; a capture-time regex guess or a fallback
               * is shown as approximate (ADR-0009: confidence recorded, never
               * implied). `occupationSource` is meaningful only with an id.
               */}
              {job.nocCode && (
                <span className="chip">
                  NOC {job.nocCode}
                  {job.occupationId && (job.occupationSource === 'title_exact' || job.occupationSource === 'title_alternate') ? '' : ' (approx.)'}
                </span>
              )}
              {job.occupation && (
                <span className="chip">
                  {job.occupation.labels.find((l) => l.locale === 'en')?.title ?? job.occupation.slug}
                  {job.occupationSource === 'title_exact' || job.occupationSource === 'title_alternate' ? '' : ' (approx.)'}
                </span>
              )}
            </div>
            {attribution && <p className="mt-2 text-xs text-faint">Occupation data: {attribution}</p>}
            {/* Stage 06: one canonical job, every source that carries it named — the provenance the Job Folder relies on. */}
            {job.provenance.length > 0 && (
              <p className="mt-2 text-xs text-faint">
                Listed by{' '}
                {job.provenance.map((p, i) => (
                  <span key={p.id}>
                    {i > 0 ? ', ' : ''}
                    {p.applyUrl ? (
                      <a href={p.applyUrl} target="_blank" rel="noopener noreferrer" className="underline hover:text-ink">
                        {sourceNames.get(p.sourceId) ?? 'a registered source'}
                      </a>
                    ) : (
                      sourceNames.get(p.sourceId) ?? 'a registered source'
                    )}
                  </span>
                ))}
                {job.provenance.length > 1 ? ` — ${job.provenance.length} sources merged into one posting; each link is that source's own` : ''}
              </p>
            )}
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
          <EligibilityPanel verdict={eligibility.verdict} evaluatedAt={eligibility.result.evaluatedAt} />
          {occupationCredentials.length > 0 ? (
            <CredentialWhatIf jobId={job.id} credentials={occupationCredentials.map((c) => ({ id: c.credential.id, name: c.credential.name, requirement: c.requirement, recognition: c.credential.recognition }))} />
          ) : null}
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
                {(Object.keys(BREAKDOWN_LABELS) as (keyof ScoreBreakdown)[]).map((key) => {
                  const dim = match.dimensions.find((d) => d.dimension === key);
                  const evidenceIds = dim ? parseJson<string[]>(dim.evidenceIds, []) : [];
                  return (
                    <div key={key}>
                      <div className="mb-1 flex items-baseline justify-between text-xs">
                        <span className="text-muted">
                          {BREAKDOWN_LABELS[key]}
                          {dim && <span className="ml-1 text-faint">· weight {Math.round(dim.weight * 100)}%</span>}
                        </span>
                        <span className="font-semibold tabular-nums text-ink">{breakdown[key]}%</span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-raised">
                        <div
                          className="h-full rounded-full bg-brand-500"
                          style={{ width: `${breakdown[key]}%` }}
                        />
                      </div>
                      {/* Stage 08: every dimension says what it measured and cites the approved evidence behind it. */}
                      {dim && (
                        <p className="mt-1 text-xs text-faint">
                          {dim.note}
                          {evidenceIds.length > 0 && (
                            <>
                              {' '}
                              Evidence: {evidenceIds.slice(0, 3).map((id) => claimById.get(id) ?? 'an approved claim').join('; ')}
                              {evidenceIds.length > 3 ? ` and ${evidenceIds.length - 3} more` : ''}.
                            </>
                          )}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
              {match.weightVersion && (
                <p className="mt-3 text-xs text-faint">
                  Scored with weight version {match.weightVersion === 'builtin:1' ? 'built-in baseline' : match.weightVersion}
                  {match.pipelineVersion ? `, pipeline ${match.pipelineVersion}` : ''}. Eligibility was checked first and separately.
                </p>
              )}
            </Card>
          )}

          {(matched.length > 0 || missing.length > 0) && (
            <Card className="p-5">
              <h2 className="mb-3 font-semibold text-ink">Keyword analysis</h2>
              {matched.length > 0 && (
                <>
                  <p className="mb-2 text-xs font-medium text-success">You match these</p>
                  <div className="mb-4 flex flex-wrap gap-1.5">
                    {matched.map((k) => {
                      const via = semanticVia.get(k.toLowerCase());
                      return (
                        <span key={k} className="chip bg-success/10 text-success" title={via !== undefined ? `Matched through the equivalence map: your résumé says "${via}".` : undefined}>
                          {k}
                          {via !== undefined && <span className="ml-1 opacity-70">≈ {via}</span>}
                        </span>
                      );
                    })}
                  </div>
                </>
              )}
              {missing.length > 0 && (
                <>
                  <p className="mb-2 text-xs font-medium text-faint">Named but not evidenced</p>
                  <div className="flex flex-wrap gap-1.5">
                    {missing.map((k) => (
                      <span key={k} className="chip" title={preferredMissing.has(k.toLowerCase()) ? 'A nice-to-have in the posting, not a requirement.' : undefined}>
                        {k}
                        {preferredMissing.has(k.toLowerCase()) && <span className="ml-1 text-faint">· nice-to-have</span>}
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

            {firstParty ? <ApplyThroughPlatform jobId={job.id} company={job.company} requisitionOpen={firstParty.status === 'open'} applied={firstParty.submissions[0]?.stage ?? null} /> : null}

            {job.applyUrl && !firstParty && (
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
