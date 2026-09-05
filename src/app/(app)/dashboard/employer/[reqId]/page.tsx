import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { requireTenant } from '@/lib/tenancy/request';
import { requestMeta } from '@/lib/security-audit';
import { OrganizationAccessError } from '@/lib/tenancy/organizations';
import { EmployerError, loadRequisition, requireEmployerActor } from '@/lib/employer/service';
import { canSource } from '@/lib/employer/roles';
import { Card, PageHeader, StatusBadge } from '@/components/ui';
import { EmployerPipeline } from '@/components/employer-pipeline';

export const dynamic = 'force-dynamic';

/** /dashboard/employer/:reqId - one requisition: its posting, its pipeline (names only for disclosed candidates) and sourcing. */
export default async function RequisitionPage({ params, searchParams }: { params: Promise<{ reqId: string }>; searchParams: Promise<{ org?: string }> }) {
  const { reqId } = await params;
  const { org } = await searchParams;
  if (!org) notFound();
  let gate: { actor: Awaited<ReturnType<typeof requireEmployerActor>>; view: Awaited<ReturnType<typeof loadRequisition>> };
  try {
    const { user, run } = await requireTenant(org);
    const actor = await requireEmployerActor({ id: user.id, email: user.email }, org, requestMeta(undefined));
    gate = { actor, view: await run((tx) => loadRequisition(tx, actor, reqId)) };
  } catch (error) {
    if (error instanceof EmployerError || error instanceof OrganizationAccessError) notFound();
    throw error;
  }
  const { actor, view } = gate;
  const r = view.requisition;
  const skills = (json: string) => {
    try {
      return (JSON.parse(json) as string[]).join(', ');
    } catch {
      return '';
    }
  };
  return (
    <>
      <Link href={`/dashboard/employer?org=${org}`} className="mb-5 inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-ink">
        <ArrowLeft className="h-4 w-4" />
        Hiring
      </Link>
      <PageHeader title={r.title} description={`${r.location} · ${r.workMode} · ${r.jobType.replace('_', ' ')}`} />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <EmployerPipeline organizationId={org} requisitionId={r.id} status={r.status} canWrite={view.canWrite} canSource={canSource(actor.role)} rows={view.submissions.map((s) => ({ id: s.id, stage: s.stage, source: s.source, disclosed: s.disclosed, candidate: s.candidate, counts: s.counts }))} />
        </div>
        <div className="space-y-6">
          <Card className="p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-ink">Requisition</h2>
              <StatusBadge status={r.status} />
            </div>
            <dl className="mt-2 space-y-1 text-sm">
              <div>
                <dt className="text-xs text-muted">Required skills</dt>
                <dd className="text-ink">{skills(r.requiredSkills) || '—'}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Preferred skills</dt>
                <dd className="text-ink">{skills(r.preferredSkills) || '—'}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Salary</dt>
                <dd className="text-ink">{r.salaryMin != null || r.salaryMax != null ? `${r.salaryMin?.toLocaleString('en-CA') ?? '?'} – ${r.salaryMax?.toLocaleString('en-CA') ?? '?'} ${r.salaryCurrency}` : 'Not stated'}</dd>
              </div>
            </dl>
            {r.jobId ? (
              <Link href={`/dashboard/jobs/${r.jobId}`} className="mt-3 inline-block text-xs underline">
                View the published posting
              </Link>
            ) : (
              <p className="mt-3 text-xs text-muted">Not published: open the requisition to publish it on this platform.</p>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
