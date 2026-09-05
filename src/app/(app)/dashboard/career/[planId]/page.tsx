import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { requireTenant } from '@/lib/tenancy/request';
import { loadPlan } from '@/lib/career/service';
import { listEvidence } from '@/lib/evidence/vault';
import { Card, PageHeader, cn } from '@/components/ui';
import { CareerPlanMilestones } from '@/components/career-plan-view';

export const dynamic = 'force-dynamic';

const BAND = { low: 'text-success', moderate: 'text-warning', high: 'text-danger' } as const;

/** /dashboard/career/:planId - one plan version: the analysis in full and the milestones. */
export default async function CareerPlanPage({ params }: { params: Promise<{ planId: string }> }) {
  const { planId } = await params;
  const { user, run } = await requireTenant();
  const { plan, evidence } = await run(async (tx) => ({ plan: await loadPlan(tx, user.id, planId), evidence: await listEvidence(tx, user.id, 'approved') }));
  if (!plan) notFound();
  const a = plan.analysis;

  return (
    <>
      <Link href="/dashboard/career" className="mb-5 inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-ink">
        <ArrowLeft className="h-4 w-4" />
        Career transition
      </Link>
      <PageHeader
        title={plan.title}
        description={`Version ${plan.version}${plan.status === 'archived' ? ' (archived)' : ''} · target: ${a.targetTitle} · engine ${plan.engineVersion} · computed ${new Date(a.computedAt).toLocaleDateString('en-CA')}`}
      />
      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        <div className="space-y-6">
          <Card className="p-5">
            <h2 className="text-base font-semibold text-ink">Transition difficulty</h2>
            <p className={cn('mt-1 text-2xl font-bold', BAND[a.difficulty.band])}>
              {a.difficulty.band} <span className="text-sm font-normal text-muted">({a.difficulty.score} of 100)</span>
            </p>
            <ul className="mt-2 space-y-1 text-sm text-muted">
              {a.difficulty.factors.map((f) => (
                <li key={f.factor}>
                  <span className="text-ink">{f.points > 0 ? `+${f.points}` : f.points}</span> · {f.detail}
                </li>
              ))}
              {a.difficulty.factors.length === 0 ? <li>No gap the engine can see: your profile covers what the target lists.</li> : null}
            </ul>
          </Card>

          <Card className="p-5">
            <h2 className="text-base font-semibold text-ink">What transfers</h2>
            {a.transferable.length === 0 ? (
              <p className="mt-1 text-sm text-muted">None of the target&apos;s listed skills is on your profile yet - or the target lists none under a recorded licence.</p>
            ) : (
              <ul className="mt-2 flex flex-wrap gap-2">
                {a.transferable.map((s) => (
                  <li key={s.skillId} className="rounded-full bg-raised px-3 py-1 text-sm text-ink">
                    {s.name}
                    {s.importance !== null ? <span className="ml-1 text-xs text-muted">{s.importance}/5</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="p-5">
            <h2 className="text-base font-semibold text-ink">Gaps</h2>
            <h3 className="mt-2 text-sm font-medium text-muted">Credentials</h3>
            {a.gaps.credentials.length === 0 ? (
              <p className="text-sm text-muted">None listed for the target, or you hold them all.</p>
            ) : (
              <ul className="mt-1 space-y-1 text-sm">
                {a.gaps.credentials.map((c) => (
                  <li key={c.credentialId}>
                    <span className="text-ink">{c.name}</span> <span className="text-xs text-muted">({c.requirement}{c.regulated ? ', regulated' : ''}; recognition as stated: {c.recognition})</span>
                  </li>
                ))}
              </ul>
            )}
            <h3 className="mt-3 text-sm font-medium text-muted">Skills</h3>
            {a.gaps.skills.length === 0 ? (
              <p className="text-sm text-muted">None.</p>
            ) : (
              <ul className="mt-1 space-y-1 text-sm">
                {a.gaps.skills.map((s) => (
                  <li key={s.skillId}>
                    <span className="text-ink">{s.name}</span>
                    {s.importance !== null ? <span className="ml-1 text-xs text-muted">importance {s.importance}/5</span> : null}
                    <span className="ml-1 text-xs text-faint">{s.coveredBy.length === 0 ? '· no licensed offering covers it yet' : `· ${s.coveredBy.length} offering${s.coveredBy.length === 1 ? '' : 's'}`}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="p-5">
            <h2 className="text-base font-semibold text-ink">Pathway</h2>
            <ol className="mt-2 space-y-2 text-sm">
              {a.pathway.map((step) => (
                <li key={step.order} className="rounded-md border border-line p-3">
                  <p className="text-ink">
                    <span className="mr-2 text-xs text-muted">{step.order}.</span>
                    {step.title}
                  </p>
                  <p className="mt-1 text-xs text-muted">{step.why}</p>
                  {step.provenance ? <p className="mt-1 text-xs text-faint">Source: {step.provenance.attribution}</p> : null}
                </li>
              ))}
              {a.pathway.length === 0 ? <li className="text-muted">Nothing to add.</li> : null}
            </ol>
          </Card>
        </div>

        <div className="space-y-6">
          <CareerPlanMilestones plan={plan} evidence={evidence.map((e) => ({ id: e.id, claim: e.claim }))} />
          <Card className="p-5">
            <h2 className="text-base font-semibold text-ink">Postings held here</h2>
            <p className="mt-1 text-sm text-muted">{a.market.note}</p>
          </Card>
          <Card className="p-5 text-xs text-muted">
            <p className="font-medium text-ink">What this is and is not</p>
            <ul className="mt-1 list-disc space-y-1 pl-4">
              {a.honesty.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
            {a.provenance.length > 0 ? (
              <>
                <p className="mt-3 font-medium text-ink">Datasets used</p>
                <ul className="mt-1 space-y-0.5">
                  {a.provenance.map((p) => (
                    <li key={p.datasetKey}>{p.attribution}</li>
                  ))}
                </ul>
              </>
            ) : null}
          </Card>
        </div>
      </div>
    </>
  );
}
