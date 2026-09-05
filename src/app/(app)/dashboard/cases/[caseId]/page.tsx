import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { requireTenant } from '@/lib/tenancy/request';
import { requestMeta } from '@/lib/security-audit';
import { CaseError, assignableMembers, listAssessments, listNotes, loadCase, requireCaseActor } from '@/lib/cases/service';
import { OrganizationAccessError } from '@/lib/tenancy/organizations';
import { readClientSummary, type ClientSummary } from '@/lib/cases/client-view';
import { Card, PageHeader } from '@/components/ui';
import { CaseRecord } from '@/components/case-record';

export const dynamic = 'force-dynamic';

/** /dashboard/cases/:caseId - one case: the client's consented job-search summary, the plan, outcomes, the RESTRICTED notes and assessments (each read audited), and the copilot's recommendations. */
export default async function CasePage({ params, searchParams }: { params: Promise<{ caseId: string }>; searchParams: Promise<{ org?: string }> }) {
  const { caseId } = await params;
  const { org } = await searchParams;
  if (!org) notFound();
  // A non-member, a non-provider organisation or a case the role may not open
  // are all "not found" - the page never learns which (Stage 17 review, L10).
  let gate: { actor: Awaited<ReturnType<typeof requireCaseActor>>; run: Awaited<ReturnType<typeof requireTenant>>['run']; view: Awaited<ReturnType<typeof loadCase>> };
  try {
    const { user, run } = await requireTenant(org);
    const actor = await requireCaseActor({ id: user.id, email: user.email }, org, requestMeta(undefined));
    gate = { actor, run, view: await run((tx) => loadCase(tx, actor, caseId)) };
  } catch (error) {
    if (error instanceof CaseError || error instanceof OrganizationAccessError) notFound();
    throw error;
  }
  const { actor, run, view } = gate;
  const c = view.case;
  const [notes, assessments, members] = await Promise.all([run((tx) => listNotes(tx, actor, caseId)), run((tx) => listAssessments(tx, actor, caseId)), run((tx) => assignableMembers(tx, actor))]);
  let summary: ClientSummary | null = null;
  let summaryNote: string | null = null;
  if (c.status === 'open') {
    try {
      summary = await readClientSummary(actor, caseId);
    } catch (error) {
      if (error instanceof CaseError) summaryNote = error.message;
      else throw error;
    }
  } else {
    summaryNote = c.status === 'invited' ? 'The client has not accepted the invitation; nothing about them is read.' : 'The case is not open; the client’s data is no longer read.';
  }
  const memberRows = await db.membership.findMany({ where: { organizationId: org, userId: { in: members.map((m) => m.userId) } }, include: { user: { select: { fullName: true, email: true } } } });
  const memberOptions = members.map((m) => ({ userId: m.userId, label: memberRows.find((r) => r.userId === m.userId)?.user.fullName ?? m.userId }));

  return (
    <>
      <Link href={`/dashboard/cases?org=${org}`} className="mb-5 inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-ink">
        <ArrowLeft className="h-4 w-4" />
        Caseload
      </Link>
      <PageHeader title={view.client.name ?? view.client.email ?? 'Client'} description={`${c.status}${c.employmentGoal ? ` · goal: ${c.employmentGoal}` : ''}${c.openedAt ? ` · opened ${c.openedAt.toLocaleDateString('en-CA')}` : ''}`} />
      <div className="grid gap-6 lg:grid-cols-[2fr_3fr]">
        <div className="space-y-6">
          <Card className="p-5">
            <h2 className="text-base font-semibold text-ink">Job search (with the client&apos;s consent)</h2>
            {summary ? (
              <div className="mt-2 space-y-2 text-sm">
                <p className="text-muted">
                  {summary.counts.total} applications · {summary.counts.submitted} submitted · {summary.counts.responded} responded · {summary.counts.interviews} interviews · {summary.counts.offers} offers
                  {summary.lastActivityAt ? ` · last active ${new Date(summary.lastActivityAt).toLocaleDateString('en-CA')}` : ''}
                </p>
                <p className="text-muted">
                  Résumé: {summary.resume.exists ? `yes, ${summary.resume.versions} document version${summary.resume.versions === 1 ? '' : 's'}` : 'none'} · {summary.profile.skillsCount} skills · targets: {summary.profile.targetTitles.join(', ') || 'none'} · {summary.profile.locationsCount} location{summary.profile.locationsCount === 1 ? '' : 's'}, relocation {summary.profile.relocation}
                </p>
                <p className="text-muted">
                  Eligibility: {summary.eligibility.evaluated} postings checked
                  {Object.keys(summary.eligibility.failsByRule).length
                    ? `; excluded on ${Object.entries(summary.eligibility.failsByRule)
                        .map(([k, v]) => `${k.replace('_', ' ')} (${v})`)
                        .join(', ')}`
                    : ''}
                  {summary.market.targetOccupationSet ? ` · ${summary.market.postingsOpen ?? 0} open postings held here for the target occupation` : ' · no target occupation on the case'}
                </p>
                {summary.applications.length ? (
                  <ul className="mt-2 divide-y divide-line">
                    {summary.applications.slice(0, 10).map((a) => (
                      <li key={a.id} className="flex justify-between py-1">
                        <span className="text-ink">
                          {a.title} <span className="text-xs text-muted">{a.company}</span>
                        </span>
                        <span className="text-xs text-muted">{a.status.replace('_', ' ')}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {summary.interviews.length ? <p className="text-xs text-muted">Upcoming: {summary.interviews.map((i) => `${i.title} (${new Date(i.scheduledAt).toLocaleDateString('en-CA')})`).join('; ')}</p> : null}
                <p className="text-xs text-faint">This read was recorded. Self-identification answers are never shown here.</p>
              </div>
            ) : (
              <p className="mt-2 text-sm text-muted">{summaryNote}</p>
            )}
          </Card>
        </div>
        <CaseRecord
          organizationId={org}
          caseId={c.id}
          status={c.status}
          canWrite={view.canWrite}
          canManage={view.canManage}
          members={memberOptions}
          caseManagerId={c.caseManagerId}
          tasks={view.tasks.map((t) => ({ id: t.id, kind: t.kind, title: t.title, description: t.description, status: t.status, dueAt: t.dueAt?.toISOString() ?? null }))}
          recommendations={view.recommendations.map((r) => ({ id: r.id, pattern: r.pattern, severity: r.severity, detail: JSON.parse(r.detail) as Record<string, unknown>, suggestedAction: r.suggestedAction, status: r.status, decisionNote: r.decisionNote, createdAt: r.createdAt.toISOString() }))}
          followUps={view.followUps.map((f) => ({ id: f.id, dueAt: f.dueAt.toISOString(), status: f.status, note: f.note }))}
          notes={notes.map((n) => ({ id: n.id, authorEmail: n.authorEmail, body: n.body, createdAt: n.createdAt.toISOString() }))}
          assessments={assessments.map((a) => ({ id: a.id, kind: a.kind, summary: a.summary, barriers: JSON.parse(a.barriers) as string[], employmentGoal: a.employmentGoal, createdAt: a.createdAt.toISOString() }))}
        />
      </div>
    </>
  );
}
