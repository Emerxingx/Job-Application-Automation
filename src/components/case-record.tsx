'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Card, cn } from '@/components/ui';

interface Task {
  id: string;
  kind: string;
  title: string;
  description: string;
  status: string;
  dueAt: string | null;
}
interface Recommendation {
  id: string;
  pattern: string;
  severity: string;
  detail: Record<string, unknown>;
  suggestedAction: string;
  status: string;
  decisionNote: string;
  createdAt: string;
}
interface FollowUp {
  id: string;
  dueAt: string;
  status: string;
  note: string;
}
interface NoteView {
  id: string;
  authorEmail: string;
  body: string;
  createdAt: string;
}
interface AssessmentView {
  id: string;
  kind: string;
  summary: string;
  barriers: string[];
  employmentGoal: string;
  createdAt: string;
}

const PATTERN_LABEL: Record<string, string> = {
  poor_response_rate: 'Poor response rate',
  unrealistic_seniority: 'Seniority above the profile',
  missing_qualifications: 'Missing qualifications',
  geographic_constraints: 'Geographic constraints',
  resume_problems: 'Résumé problems',
  weak_demand: 'Weak demand held here',
  certification_gaps: 'Certification gaps',
  inactive: 'Inactive',
  no_target: 'No target',
};

async function call(url: string, method: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    return res.ok ? { ok: true } : { ok: false, error: data.error ?? 'Request failed.' };
  } catch {
    return { ok: false, error: 'Could not reach the server.' };
  }
}

/**
 * Stage 17 (ADR-0032): the case record's writable parts. Notes and
 * assessments are RESTRICTED - shown here only because the page's read was
 * audited; the copilot recommends and the case manager decides.
 */
export function CaseRecord({ organizationId, caseId, status, canWrite, canManage, members, caseManagerId, tasks, recommendations, followUps, notes, assessments }: { organizationId: string; caseId: string; status: string; canWrite: boolean; canManage: boolean; members: { userId: string; label: string }[]; caseManagerId: string | null; tasks: Task[]; recommendations: Recommendation[]; followUps: FollowUp[]; notes: NoteView[]; assessments: AssessmentView[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [summary, setSummary] = useState('');
  const [barriers, setBarriers] = useState('');
  const [taskTitle, setTaskTitle] = useState('');
  const [taskKind, setTaskKind] = useState<'task' | 'intervention' | 'referral'>('task');
  const [offeringId, setOfferingId] = useState('');
  const [outcomeKind, setOutcomeKind] = useState('employed');
  const [employer, setEmployer] = useState('');
  const [closeReason, setCloseReason] = useState('service_complete');
  const open = status === 'open';

  async function run(key: string, url: string, method: string, body: unknown, after?: () => void) {
    setBusy(key);
    setError(null);
    const r = await call(url, method, body);
    setBusy(null);
    if (!r.ok) {
      setError(r.error ?? null);
      return;
    }
    after?.();
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {canManage ? (
        <Card className="p-5">
          <h2 className="text-base font-semibold text-ink">Assignment</h2>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <select className="rounded-md border border-line bg-surface px-3 py-2" value={caseManagerId ?? ''} disabled={busy !== null} onChange={(e) => run('assign', `/api/cases/${caseId}`, 'PATCH', { action: 'assign', organizationId, caseManagerId: e.target.value || null })}>
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.label}
                </option>
              ))}
            </select>
            {open ? (
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  run('close', `/api/cases/${caseId}`, 'PATCH', { action: 'close', organizationId, reason: closeReason });
                }}
              >
                <select className="rounded-md border border-line bg-surface px-3 py-2" value={closeReason} onChange={(e) => setCloseReason(e.target.value)} aria-label="Reason for closing">
                  <option value="outcome_recorded">Outcome recorded</option>
                  <option value="service_complete">Service complete</option>
                  <option value="referred_elsewhere">Referred elsewhere</option>
                  <option value="lost_contact">Lost contact</option>
                  <option value="client_request">Client request</option>
                  <option value="other">Other</option>
                </select>
                <button type="submit" className="rounded-md border border-line px-3 py-2 text-xs text-muted" disabled={busy !== null}>
                  Close case
                </button>
              </form>
            ) : null}
          </div>
        </Card>
      ) : null}

      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-ink">Copilot recommendations</h2>
          {canWrite && open ? (
            <button type="button" className="btn-secondary text-xs" disabled={busy !== null} onClick={() => run('copilot', `/api/cases/${caseId}/copilot`, 'POST', { organizationId })}>
              {busy === 'copilot' ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              Run the copilot
            </button>
          ) : null}
        </div>
        <p className="mt-1 text-xs text-muted">The copilot reads the client&apos;s applications, eligibility results, compatibility scores and profile - never a case note - and recommends. It changes nothing; you decide each one, and accepting creates a task only if you ask for one.</p>
        <ul className="mt-3 space-y-2">
          {recommendations.length === 0 ? <li className="text-sm text-muted">No recommendations yet.</li> : null}
          {recommendations.map((r) => (
            <li key={r.id} className="rounded-md border border-line p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-ink">
                  {PATTERN_LABEL[r.pattern] ?? r.pattern} <span className={cn('ml-1 text-xs', r.severity === 'high' ? 'text-danger' : r.severity === 'attention' ? 'text-warning' : 'text-muted')}>{r.severity}</span>
                </span>
                <span className="text-xs text-muted">{r.status}</span>
              </div>
              <p className="mt-1 text-muted">{r.suggestedAction}</p>
              <p className="mt-1 text-xs text-faint">
                {Object.entries(r.detail)
                  .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
                  .join(' · ')}
              </p>
              {r.status === 'open' && canWrite && open ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" className="btn-secondary text-xs" disabled={busy !== null} onClick={() => run(r.id, `/api/cases/recommendations/${r.id}`, 'PATCH', { organizationId, status: 'accepted', createTask: { kind: 'task', title: PATTERN_LABEL[r.pattern] ?? r.pattern } })}>
                    Accept and add a task
                  </button>
                  <button type="button" className="rounded-md border border-line px-3 py-1 text-xs text-muted" disabled={busy !== null} onClick={() => run(r.id, `/api/cases/recommendations/${r.id}`, 'PATCH', { organizationId, status: 'accepted' })}>
                    Accept
                  </button>
                  <button type="button" className="rounded-md border border-line px-3 py-1 text-xs text-muted" disabled={busy !== null} onClick={() => run(r.id, `/api/cases/recommendations/${r.id}`, 'PATCH', { organizationId, status: 'dismissed' })}>
                    Dismiss
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>

      <Card className="p-5">
        <h2 className="text-base font-semibold text-ink">Action plan</h2>
        <ul className="mt-2 space-y-2 text-sm">
          {tasks.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line p-2">
              <span>
                <span className="mr-2 rounded bg-raised px-1.5 py-0.5 text-xs text-muted">{t.kind}</span>
                {t.title}
                {t.dueAt ? <span className="ml-2 text-xs text-faint">due {new Date(t.dueAt).toLocaleDateString('en-CA')}</span> : null}
              </span>
              {canWrite && open ? (
                <select className="rounded border border-line bg-surface px-2 py-1 text-xs" value={t.status} disabled={busy !== null} onChange={(e) => run(t.id, `/api/cases/tasks/${t.id}`, 'PATCH', { organizationId, status: e.target.value })}>
                  {['planned', 'in_progress', 'done', 'dropped'].map((s) => (
                    <option key={s} value={s}>
                      {s.replace('_', ' ')}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-xs text-muted">{t.status.replace('_', ' ')}</span>
              )}
            </li>
          ))}
          {tasks.length === 0 ? <li className="text-muted">Nothing planned yet.</li> : null}
        </ul>
        {canWrite && open ? (
          <form
            className="mt-3 flex flex-wrap items-end gap-2 text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              run('task', `/api/cases/${caseId}/tasks`, 'POST', { organizationId, kind: taskKind, title: taskTitle, offeringId: taskKind === 'referral' ? offeringId : undefined }, () => {
                setTaskTitle('');
                setOfferingId('');
              });
            }}
          >
            <select className="rounded-md border border-line bg-surface px-3 py-2" value={taskKind} onChange={(e) => setTaskKind(e.target.value as typeof taskKind)}>
              <option value="task">Task</option>
              <option value="intervention">Intervention</option>
              <option value="referral">Training referral</option>
            </select>
            <input className="min-w-[16rem] flex-1 rounded-md border border-line bg-surface px-3 py-2" placeholder="Title" value={taskTitle} minLength={2} required onChange={(e) => setTaskTitle(e.target.value)} />
            {taskKind === 'referral' ? <input className="rounded-md border border-line bg-surface px-3 py-2" placeholder="Licensed offering id" value={offeringId} required onChange={(e) => setOfferingId(e.target.value)} /> : null}
            <button type="submit" className="btn-secondary" disabled={busy !== null}>
              Add
            </button>
          </form>
        ) : null}
      </Card>

      <Card className="p-5">
        <h2 className="text-base font-semibold text-ink">Outcomes and retention follow-up</h2>
        <ul className="mt-2 space-y-1 text-sm">
          {followUps.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>
                Follow-up due {new Date(f.dueAt).toLocaleDateString('en-CA')} <span className="text-xs text-muted">{f.status.replace('_', ' ')}</span>
              </span>
              {canWrite && f.status === 'pending' ? (
                <span className="flex gap-1">
                  {['retained', 'not_retained', 'unknown'].map((s) => (
                    <button key={s} type="button" className="rounded border border-line px-2 py-0.5 text-xs text-muted" disabled={busy !== null} onClick={() => run(f.id, `/api/cases/follow-ups/${f.id}`, 'PATCH', { organizationId, status: s })}>
                      {s.replace('_', ' ')}
                    </button>
                  ))}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
        {canWrite && open ? (
          <form
            className="mt-3 flex flex-wrap items-end gap-2 text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              run('outcome', `/api/cases/${caseId}/outcomes`, 'POST', { organizationId, kind: outcomeKind, employerName: employer || undefined }, () => setEmployer(''));
            }}
          >
            <select className="rounded-md border border-line bg-surface px-3 py-2" value={outcomeKind} onChange={(e) => setOutcomeKind(e.target.value)}>
              {['employed', 'self_employed', 'training', 'not_employed', 'other'].map((k) => (
                <option key={k} value={k}>
                  {k.replace('_', ' ')}
                </option>
              ))}
            </select>
            <input className="rounded-md border border-line bg-surface px-3 py-2" placeholder="Employer (optional)" value={employer} onChange={(e) => setEmployer(e.target.value)} />
            <button type="submit" className="btn-secondary" disabled={busy !== null}>
              Record outcome
            </button>
          </form>
        ) : null}
      </Card>

      <Card className="p-5">
        <h2 className="text-base font-semibold text-ink">Assessments</h2>
        <p className="mt-1 text-xs text-muted">Restricted. Each read of this section is recorded. Nothing here reaches matching, scoring or an AI provider.</p>
        <ul className="mt-2 space-y-2 text-sm">
          {assessments.map((a) => (
            <li key={a.id} className="rounded-md border border-line p-2">
              <p className="text-xs text-muted">
                {a.kind} · {new Date(a.createdAt).toLocaleDateString('en-CA')}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-ink">{a.summary}</p>
              {a.barriers.length ? <p className="mt-1 text-xs text-muted">Barriers: {a.barriers.join('; ')}</p> : null}
            </li>
          ))}
        </ul>
        {canWrite && open ? (
          <form
            className="mt-3 space-y-2 text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              run('assessment', `/api/cases/${caseId}/assessments`, 'POST', { organizationId, kind: assessments.length ? 'review' : 'intake', summary, barriers: barriers.split(';').map((b) => b.trim()).filter(Boolean) }, () => {
                setSummary('');
                setBarriers('');
              });
            }}
          >
            <textarea className="w-full rounded-md border border-line bg-surface px-3 py-2" rows={3} placeholder="Assessment summary" value={summary} maxLength={5000} onChange={(e) => setSummary(e.target.value)} />
            <input className="w-full rounded-md border border-line bg-surface px-3 py-2" placeholder="Barriers, separated by semicolons" value={barriers} onChange={(e) => setBarriers(e.target.value)} />
            <button type="submit" className="btn-secondary" disabled={busy !== null}>
              Record assessment
            </button>
          </form>
        ) : null}
      </Card>

      <Card className="p-5">
        <h2 className="text-base font-semibold text-ink">Case notes</h2>
        <p className="mt-1 text-xs text-muted">Restricted. Each read of this section is recorded.</p>
        <ul className="mt-2 space-y-2 text-sm">
          {notes.map((n) => (
            <li key={n.id} className="rounded-md border border-line p-2">
              <p className="text-xs text-muted">
                {n.authorEmail} · {new Date(n.createdAt).toLocaleString('en-CA')}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-ink">{n.body}</p>
            </li>
          ))}
          {notes.length === 0 ? <li className="text-muted">No notes.</li> : null}
        </ul>
        {canWrite && open ? (
          <form
            className="mt-3 space-y-2 text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              run('note', `/api/cases/${caseId}/notes`, 'POST', { organizationId, body: note }, () => setNote(''));
            }}
          >
            <textarea className="w-full rounded-md border border-line bg-surface px-3 py-2" rows={3} placeholder="Write a note" value={note} maxLength={5000} required onChange={(e) => setNote(e.target.value)} />
            <button type="submit" className="btn-secondary" disabled={busy !== null}>
              {busy === 'note' ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              Add note
            </button>
          </form>
        ) : null}
      </Card>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
