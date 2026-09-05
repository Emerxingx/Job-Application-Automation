import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { db } from '@/lib/db';
import { requireTenant } from '@/lib/tenancy/request';
import { requestMeta } from '@/lib/security-audit';
import { OrganizationAccessError } from '@/lib/tenancy/organizations';
import { EmployerError, loadSubmission, requireEmployerActor } from '@/lib/employer/service';
import { readDisclosedCandidate, type DisclosedProfile } from '@/lib/employer/candidate-view';
import { canDecideOffer } from '@/lib/employer/roles';
import { Card, PageHeader } from '@/components/ui';
import { EmployerSubmission } from '@/components/employer-submission';

export const dynamic = 'force-dynamic';

/** /dashboard/employer/submissions/:id - one candidate in a pipeline. The profile is read (and the read recorded) only for a candidate who granted disclosure to this organisation. */
export default async function SubmissionPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ org?: string }> }) {
  const { id } = await params;
  const { org } = await searchParams;
  if (!org) notFound();
  let gate: { actor: Awaited<ReturnType<typeof requireEmployerActor>>; view: Awaited<ReturnType<typeof loadSubmission>> };
  try {
    const { user, run } = await requireTenant(org);
    const actor = await requireEmployerActor({ id: user.id, email: user.email }, org, requestMeta(undefined));
    gate = { actor, view: await run((tx) => loadSubmission(tx, actor, id)) };
  } catch (error) {
    if (error instanceof EmployerError || error instanceof OrganizationAccessError) notFound();
    throw error;
  }
  const { actor, view } = gate;
  let profile: DisclosedProfile | null = null;
  if (view.disclosed) {
    try {
      profile = await readDisclosedCandidate(actor, view.submission.candidateUserId);
    } catch (error) {
      if (!(error instanceof EmployerError)) throw error;
    }
  }
  const members = await db.membership.findMany({ where: { organizationId: org, acceptedAt: { not: null }, removedAt: null }, include: { user: { select: { fullName: true } } } });
  const parse = (json: string) => {
    try {
      return JSON.parse(json) as string[];
    } catch {
      return [];
    }
  };
  return (
    <>
      <Link href={`/dashboard/employer/${view.submission.requisitionId}?org=${org}`} className="mb-5 inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-ink">
        <ArrowLeft className="h-4 w-4" />
        Requisition
      </Link>
      <PageHeader title={profile ? profile.fullName : 'Undisclosed candidate'} description={profile ? [profile.headline, profile.location].filter(Boolean).join(' · ') : 'The candidate has not granted disclosure to your organisation.'} />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <EmployerSubmission
            organizationId={org}
            interviewers={members.map((m) => ({ userId: m.userId, label: m.user.fullName }))}
            view={{
              id: view.submission.id,
              stage: view.submission.stage,
              disclosed: view.disclosed,
              canWrite: view.canWrite,
              canOffer: canDecideOffer(actor.role, view.submission.requisition, actor.user.id),
              events: view.events.map((e) => ({ id: e.id, fromStage: e.fromStage, toStage: e.toStage, note: e.note, at: e.at.toISOString() })),
              interviews: view.interviews.map((i) => ({ id: i.id, kind: i.kind, scheduledAt: i.scheduledAt.toISOString(), outcome: i.outcome, feedback: i.feedback, interviewerIds: parse(i.interviewerIds) })),
              notes: view.notes.map((n) => ({ id: n.id, authorEmail: n.authorEmail, body: n.body, createdAt: n.createdAt.toISOString() })),
              offers: view.offers.map((o) => ({ id: o.id, status: o.status, salaryCents: o.salaryCents, currency: o.currency, startDate: o.startDate?.toISOString() ?? null, note: o.note })),
            }}
          />
        </div>
        <div className="space-y-6">
          <Card className="p-5">
            <h2 className="text-base font-semibold text-ink">Profile</h2>
            {profile ? (
              <div className="mt-2 space-y-2 text-sm">
                <p className="text-xs text-muted">This read was recorded. Contact: {profile.email}{profile.phone ? ` · ${profile.phone}` : ''}</p>
                {profile.summary ? <p className="text-ink">{profile.summary}</p> : null}
                <p className="text-xs text-muted">Skills: {profile.skills.join(', ') || '—'}</p>
                <ul className="space-y-1">
                  {profile.experience.map((e, i) => (
                    <li key={i}>
                      <span className="font-medium text-ink">{e.title}</span> <span className="text-muted">· {e.company} · {e.period}</span>
                    </li>
                  ))}
                </ul>
                <ul className="space-y-1 text-muted">
                  {profile.education.map((e, i) => (
                    <li key={i}>
                      {e.degree}, {e.school} ({e.period})
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-muted">{profile.approvedClaims} approved evidence claim{profile.approvedClaims === 1 ? '' : 's'} on file.</p>
              </div>
            ) : (
              <p className="mt-2 text-xs text-muted">Shown once the candidate grants disclosure to your organisation. Ask from the requisition&rsquo;s sourcing view.</p>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
