import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Briefcase } from 'lucide-react';
import { db } from '@/lib/db';
import { requireTenant } from '@/lib/tenancy/request';
import { requestMeta } from '@/lib/security-audit';
import { CaseError, assignableMembers, caseloadSummary, listCaseload, requireCaseActor, serviceProviderMemberships } from '@/lib/cases/service';
import { canManageCaseload } from '@/lib/cases/roles';
import { MartFreshnessNote } from '@/components/mart-freshness';
import { OrganizationAccessError } from '@/lib/tenancy/organizations';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { CaseInvite } from '@/components/case-invite';
import { CaseSettings } from '@/components/case-settings';

export const metadata = { title: 'Case management' };
export const dynamic = 'force-dynamic';

/**
 * /dashboard/cases - Stage 17 (ADR-0032). The caseload of a service-provider
 * organisation the person belongs to, as their role sees it. Level 0: this
 * platform runs ALONGSIDE WorkBC systems and has no connection to them
 * (ADR-0020); the page says so.
 */
export default async function CasesPage({ searchParams }: { searchParams: Promise<{ org?: string; status?: string }> }) {
  const params = await searchParams;
  const { user } = await requireTenant();
  const memberships = await serviceProviderMemberships(user.id);
  if (memberships.length === 0) {
    return (
      <>
        <PageHeader title="Case management" description="For employment service providers working alongside their clients on this platform." />
        <EmptyState icon={<Briefcase className="h-5 w-5" />} title="You are not a member of a service-provider organisation" description="An organisation administrator adds members. If a provider has invited you as a client, the invitation is under Settings." />
      </>
    );
  }
  const current = memberships.find((m) => m.organizationId === params.org) ?? memberships[0]!;
  // The organisation is one of the caller's own memberships, so a refusal
  // here is a race (membership removed since the list was read) and is a
  // 404, not a server error (Stage 17 review, L10).
  let page: { actor: Awaited<ReturnType<typeof requireCaseActor>>; caseload: Awaited<ReturnType<typeof listCaseload>>; members: Awaited<ReturnType<typeof assignableMembers>>; summary: Awaited<ReturnType<typeof caseloadSummary>> | null };
  try {
    const { run } = await requireTenant(current.organizationId);
    const actor = await requireCaseActor({ id: user.id, email: user.email }, current.organizationId, requestMeta(undefined));
    const to = new Date();
    const range = { from: new Date(to.getTime() - 90 * 86_400_000), to };
    const [caseload, members, summary] = await Promise.all([run((tx) => listCaseload(tx, actor, { status: params.status })), run((tx) => assignableMembers(tx, actor)), canManageCaseload(actor.role) ? run((tx) => caseloadSummary(tx, actor, range)) : Promise.resolve(null)]);
    page = { actor, caseload, members, summary };
  } catch (error) {
    if (error instanceof CaseError || error instanceof OrganizationAccessError) notFound();
    throw error;
  }
  const { actor, caseload, members, summary } = page;
  const policy = await db.retentionPolicy.findUnique({ where: { organizationId: current.organizationId } });
  const memberRows = await db.membership.findMany({ where: { organizationId: current.organizationId, acceptedAt: { not: null }, removedAt: null }, include: { user: { select: { fullName: true, email: true } } }, orderBy: { createdAt: 'asc' } });
  const label = (userId: string) => {
    const m = memberRows.find((r) => r.userId === userId);
    return m ? `${m.user.fullName} (${m.user.email})` : userId;
  };
  const assignable = members.map((m) => ({ userId: m.userId, label: label(m.userId) }));

  return (
    <>
      <PageHeader
        title="Case management"
        description={`${current.name} · your role: ${actor.role.replace('_', ' ')}. This platform works alongside your organisation's own systems; it is not connected to WorkBC or any government system (integration level 0).`}
      />
      {memberships.length > 1 ? (
        <p className="mb-4 text-sm text-muted">
          Organisation:{' '}
          {memberships.map((m) => (
            <Link key={m.organizationId} href={`/dashboard/cases?org=${m.organizationId}`} className={m.organizationId === current.organizationId ? 'font-medium text-ink' : 'underline'}>
              {m.name}
            </Link>
          ))}
        </p>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        <div className="space-y-6">
          {summary ? (
            <Card className="p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-semibold text-ink">Outcomes · last 90 days</h2>
                <MartFreshnessNote marts={['OrganizationDailyMart']} />
              </div>
              <p className="mt-1 text-xs text-muted">Counts from the reporting mart, never a note or a name. An outcome figure is withheld under five clients (ADR-0012).</p>
              <dl className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                <div><dt className="text-muted">Cases opened</dt><dd className="text-lg font-semibold text-ink">{summary.opened}</dd></div>
                <div><dt className="text-muted">Cases closed</dt><dd className="text-lg font-semibold text-ink">{summary.closed}</dd></div>
                <div><dt className="text-muted">Employment outcomes</dt><dd className="text-lg font-semibold text-ink">{summary.outcomes.suppressed ? <span className="text-sm text-muted">{summary.outcomes.reason}</span> : summary.outcomes.value}</dd></div>
                <div><dt className="text-muted">Follow-ups completed</dt><dd className="text-lg font-semibold text-ink">{summary.followUps.completed} / {summary.followUps.due}</dd></div>
              </dl>
              {summary.outcomesByKind.length ? (
                <p className="mt-2 text-xs text-muted">
                  By kind: {summary.outcomesByKind.map((k) => `${k.kind.replace('_', ' ')} ${k.count.suppressed ? '(withheld)' : k.count.value}`).join(' · ')}
                </p>
              ) : null}
            </Card>
          ) : null}
          <Card className="p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-ink">Caseload</h2>
              <span className="text-xs text-muted">
                {Object.entries(caseload.aggregate)
                  .map(([s, n]) => `${n} ${s}`)
                  .join(' · ') || 'no cases'}
              </span>
            </div>
            {actor.role === 'viewer' ? (
              <p className="mt-2 text-sm text-muted">A viewer sees the counts only.</p>
            ) : caseload.cases.length === 0 ? (
              <p className="mt-2 text-sm text-muted">{actor.role === 'case_manager' ? 'No case is assigned to you.' : 'No cases yet.'}</p>
            ) : (
              <ul className="mt-3 divide-y divide-line text-sm">
                {caseload.cases.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div>
                      <Link href={`/dashboard/cases/${c.id}?org=${current.organizationId}`} className="font-medium text-ink hover:underline">
                        {c.client.name ?? c.client.email ?? 'Client'}
                      </Link>
                      <p className="text-xs text-muted">
                        {c.status}
                        {c.caseManagerId ? ` · ${label(c.caseManagerId)}` : ' · unassigned'}
                        {c.employmentGoal ? ` · ${c.employmentGoal}` : ''}
                      </p>
                    </div>
                    <span className="text-xs text-faint">
                      {c.tasks} task{c.tasks === 1 ? '' : 's'} · {c.recommendations} rec.
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <div className="space-y-6">
          {caseload && (actor.role === 'admin' || actor.role === 'supervisor') ? <CaseInvite organizationId={current.organizationId} members={assignable} /> : null}
          {actor.role === 'admin' ? (
            <CaseSettings organizationId={current.organizationId} members={memberRows.map((m) => ({ userId: m.userId, label: label(m.userId), serviceRole: m.serviceRole, ladder: m.role }))} policy={policy ? { caseNoteDays: policy.caseNoteDays, closedCaseDays: policy.closedCaseDays, note: policy.note } : null} />
          ) : null}
        </div>
      </div>
    </>
  );
}
