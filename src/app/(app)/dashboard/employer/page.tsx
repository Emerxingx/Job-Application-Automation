import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Building2 } from 'lucide-react';
import { db } from '@/lib/db';
import { requireTenant } from '@/lib/tenancy/request';
import { requestMeta } from '@/lib/security-audit';
import { OrganizationAccessError } from '@/lib/tenancy/organizations';
import { EmployerError, employerMemberships, listPools, listRequisitions, reporting, requireEmployerActor } from '@/lib/employer/service';
import { canCreateRequisition } from '@/lib/employer/roles';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { EmployerRequisitions } from '@/components/employer-requisitions';
import { EmployerRoster } from '@/components/employer-roster';

export const metadata = { title: 'Hiring' };
export const dynamic = 'force-dynamic';

/**
 * /dashboard/employer - Stage 18 (ADR-0033). An employer organisation's
 * requisitions, pools, reporting and (for an admin) the hiring team. No
 * candidate is named anywhere on this page.
 */
export default async function EmployerPage({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  const params = await searchParams;
  const { user } = await requireTenant();
  const memberships = await employerMemberships(user.id);
  if (memberships.length === 0) {
    return (
      <>
        <PageHeader title="Hiring" description="For employers hiring on this platform." />
        <EmptyState icon={<Building2 className="h-5 w-5" />} title="You are not a member of an employer organisation" description="An organisation administrator adds members. Candidates you are looking for keep control of who sees them." />
      </>
    );
  }
  const current = memberships.find((m) => m.organizationId === params.org) ?? memberships[0]!;
  let page: { actor: Awaited<ReturnType<typeof requireEmployerActor>>; requisitions: Awaited<ReturnType<typeof listRequisitions>>; pools: Awaited<ReturnType<typeof listPools>>; report: Awaited<ReturnType<typeof reporting>> };
  try {
    const { run } = await requireTenant(current.organizationId);
    const actor = await requireEmployerActor({ id: user.id, email: user.email }, current.organizationId, requestMeta(undefined));
    const to = new Date();
    const from = new Date(to.getTime() - 90 * 86_400_000);
    const [requisitions, pools, report] = await Promise.all([run((tx) => listRequisitions(tx, actor)), run((tx) => listPools(tx, actor)), run((tx) => reporting(tx, actor, { from, to }))]);
    page = { actor, requisitions, pools, report };
  } catch (error) {
    if (error instanceof EmployerError || error instanceof OrganizationAccessError) notFound();
    throw error;
  }
  const { actor, requisitions, pools, report } = page;
  const members = actor.role === 'admin' ? await db.membership.findMany({ where: { organizationId: current.organizationId, acceptedAt: { not: null }, removedAt: null }, include: { user: { select: { fullName: true, email: true } } }, orderBy: { createdAt: 'asc' } }) : [];

  return (
    <>
      <PageHeader title="Hiring" description={`${current.name} · your role: ${actor.role.replace('_', ' ')}. Candidates decide who sees them: sourcing shows anonymised fit until a candidate grants disclosure to your organisation, and every look at a disclosed profile is recorded.`} />
      {memberships.length > 1 ? (
        <p className="mb-4 text-sm text-muted">
          Organisation:{' '}
          {memberships.map((m) => (
            <Link key={m.organizationId} href={`/dashboard/employer?org=${m.organizationId}`} className={m.organizationId === current.organizationId ? 'font-medium text-ink' : 'underline'}>
              {m.name}
            </Link>
          ))}
        </p>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <EmployerRequisitions organizationId={current.organizationId} canCreate={canCreateRequisition(actor.role)} rows={requisitions.map((r) => ({ id: r.id, title: r.title, status: r.status, location: r.location, jobId: r.jobId, submissions: r._count.submissions, updatedAt: r.updatedAt.toISOString() }))} />
        </div>
        <div className="space-y-6">
          <Card className="p-5">
            <h2 className="text-base font-semibold text-ink">Last 90 days</h2>
            <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
              {(
                [
                  ['In pipeline', report.funnel.submissions],
                  ['Consented', report.funnel.consented],
                  ['Screening', report.funnel.screening],
                  ['Interviewing', report.funnel.interviewing],
                  ['Offered', report.funnel.offered],
                  ['Hired', report.funnel.hired],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="rounded-md border border-line p-2">
                  <dt className="text-xs text-muted">{k}</dt>
                  <dd className="font-semibold text-ink">{v}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-2 text-xs text-muted">
              Median days to shortlist {report.daysTo.shortlist ?? '—'} · to interview {report.daysTo.interview ?? '—'} · to hire {report.daysTo.hire ?? '—'}. Counted from your own pipeline events; no candidate is named.
            </p>
          </Card>
          <Card className="p-5">
            <h2 className="text-base font-semibold text-ink">Talent pools</h2>
            <p className="text-xs text-muted">A pool holds only candidates who granted disclosure; a membership goes with the revocation.</p>
            <ul className="mt-2 text-sm">
              {pools.length === 0 ? <li className="text-muted">No pools yet.</li> : null}
              {pools.map((p) => (
                <li key={p.id} className="flex justify-between border-t border-line py-1">
                  <span className="text-ink">{p.name}</span>
                  <span className="text-muted">{p._count.members}</span>
                </li>
              ))}
            </ul>
          </Card>
          {actor.role === 'admin' ? <EmployerRoster organizationId={current.organizationId} members={members.map((m) => ({ userId: m.userId, label: `${m.user.fullName} (${m.user.email})`, role: m.role, serviceRole: m.serviceRole }))} /> : null}
        </div>
      </div>
    </>
  );
}
