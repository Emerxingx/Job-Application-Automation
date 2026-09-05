'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Card, StatusBadge } from '@/components/ui';

export interface SubmissionView {
  id: string;
  stage: string;
  disclosed: boolean;
  canWrite: boolean;
  canOffer: boolean;
  events: { id: string; fromStage: string; toStage: string; note: string; at: string }[];
  interviews: { id: string; kind: string; scheduledAt: string; outcome: string; feedback: string; interviewerIds: string[] }[];
  notes: { id: string; authorEmail: string; body: string; createdAt: string }[];
  offers: { id: string; status: string; salaryCents: number | null; currency: string; startDate: string | null; note: string }[];
}

const NEXT: Record<string, string[]> = {
  consented: ['screening', 'rejected'],
  screening: ['interviewing', 'rejected'],
  interviewing: ['rejected'],
  offered: ['rejected'],
};

/** Stage 18 (ADR-0033): one submission - its stage history, interviews, hiring-team notes and offers. Every move goes through the stage machine on the server. */
export function EmployerSubmission({ organizationId, view, interviewers }: { organizationId: string; view: SubmissionView; interviewers: { userId: string; label: string }[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [when, setWhen] = useState('');
  const [interviewer, setInterviewer] = useState('');
  const [salary, setSalary] = useState('');
  const [feedback, setFeedback] = useState<Record<string, string>>({});

  async function call(key: string, url: string, method: string, body: unknown, after?: () => void) {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'The request failed.');
        return;
      }
      after?.();
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(null);
    }
  }
  const fmt = (d: string) => new Date(d).toLocaleString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <div className="space-y-4">
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-ink">Stage</h2>
            <StatusBadge status={view.stage} />
          </div>
          {view.canWrite ? (
            <div className="flex flex-wrap gap-2">
              {(NEXT[view.stage] ?? []).map((to) => (
                <button key={to} type="button" className={to === 'rejected' ? 'rounded-md border border-line px-3 py-2 text-xs text-danger' : 'btn-secondary text-xs'} disabled={busy !== null} onClick={() => call(to, `/api/employer/submissions/${view.id}`, 'PATCH', { organizationId, to })}>
                  {to === 'rejected' ? 'Reject' : `Move to ${to}`}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {!view.disclosed ? <p className="mt-2 text-xs text-muted">The candidate has not granted disclosure to your organisation; nothing past consent is possible, and their identity is not shown.</p> : null}
        <ol className="mt-3 space-y-1 text-xs text-muted">
          {view.events.map((e) => (
            <li key={e.id}>
              {fmt(e.at)} · {e.fromStage} → {e.toStage}
              {e.note ? ` · ${e.note}` : ''}
            </li>
          ))}
        </ol>
      </Card>

      <Card className="p-5">
        <h2 className="text-base font-semibold text-ink">Interviews</h2>
        <ul className="mt-2 space-y-2 text-sm">
          {view.interviews.length === 0 ? <li className="text-muted">None scheduled.</li> : null}
          {view.interviews.map((i) => (
            <li key={i.id} className="rounded-md border border-line p-3">
              <div className="flex items-center justify-between">
                <span className="text-ink">
                  {i.kind} · {fmt(i.scheduledAt)}
                </span>
                <StatusBadge status={i.outcome} />
              </div>
              {i.feedback ? <p className="mt-1 text-xs text-muted">{i.feedback}</p> : null}
              {i.outcome === 'scheduled' ? (
                <form
                  className="mt-2 flex flex-wrap items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    call(`rec-${i.id}`, `/api/employer/interviews/${i.id}`, 'PATCH', { organizationId, outcome: 'completed', feedback: feedback[i.id] ?? '' });
                  }}
                >
                  <input className="flex-1 rounded-md border border-line bg-surface px-3 py-2 text-xs" placeholder="Feedback (the hiring team's record; never shown to the candidate)" value={feedback[i.id] ?? ''} onChange={(e) => setFeedback({ ...feedback, [i.id]: e.target.value })} />
                  <button type="submit" className="btn-secondary text-xs" disabled={busy !== null}>
                    Record outcome
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
        {view.canWrite && view.disclosed && ['consented', 'screening', 'interviewing'].includes(view.stage) ? (
          <form
            className="mt-3 flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              call('schedule', `/api/employer/submissions/${view.id}/interviews`, 'POST', { organizationId, scheduledAt: new Date(when).toISOString(), interviewerIds: interviewer ? [interviewer] : [] }, () => setWhen(''));
            }}
          >
            <label className="flex flex-col text-xs">
              <span className="text-muted">When</span>
              <input type="datetime-local" className="rounded-md border border-line bg-surface px-3 py-2" required value={when} onChange={(e) => setWhen(e.target.value)} />
            </label>
            <label className="flex flex-col text-xs">
              <span className="text-muted">Interviewer</span>
              <select className="rounded-md border border-line bg-surface px-3 py-2" value={interviewer} onChange={(e) => setInterviewer(e.target.value)}>
                <option value="">Unassigned</option>
                {interviewers.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="btn-secondary text-xs" disabled={busy !== null}>
              {busy === 'schedule' ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              Schedule
            </button>
          </form>
        ) : null}
      </Card>

      <Card className="p-5">
        <h2 className="text-base font-semibold text-ink">Notes</h2>
        <p className="text-xs text-muted">The hiring team&rsquo;s own record. Never shown to the candidate.</p>
        <ul className="mt-2 space-y-2 text-sm">
          {view.notes.map((n) => (
            <li key={n.id} className="rounded-md border border-line p-3">
              <p className="text-ink">{n.body}</p>
              <p className="text-xs text-muted">
                {n.authorEmail} · {fmt(n.createdAt)}
              </p>
            </li>
          ))}
        </ul>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            call('note', `/api/employer/submissions/${view.id}/notes`, 'POST', { organizationId, body: note }, () => setNote(''));
          }}
        >
          <input className="flex-1 rounded-md border border-line bg-surface px-3 py-2 text-sm" required value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note" />
          <button type="submit" className="btn-secondary text-xs" disabled={busy !== null}>
            Add
          </button>
        </form>
      </Card>

      <Card className="p-5">
        <h2 className="text-base font-semibold text-ink">Offers</h2>
        <ul className="mt-2 space-y-2 text-sm">
          {view.offers.length === 0 ? <li className="text-muted">No offer yet.</li> : null}
          {view.offers.map((o) => (
            <li key={o.id} className="rounded-md border border-line p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-ink">
                  {o.salaryCents != null ? `${(o.salaryCents / 100).toLocaleString('en-CA')} ${o.currency}` : 'Salary not stated'}
                  {o.startDate ? ` · starts ${new Date(o.startDate).toLocaleDateString('en-CA')}` : ''}
                </span>
                <StatusBadge status={o.status} />
              </div>
              {o.status === 'extended' && view.canOffer ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" className="btn-primary text-xs" disabled={busy !== null} onClick={() => call(`acc-${o.id}`, `/api/employer/offers/${o.id}`, 'PATCH', { organizationId, status: 'accepted', fillRequisition: window.confirm('Mark the requisition filled and close the posting?') })}>
                    Candidate accepted
                  </button>
                  <button type="button" className="rounded-md border border-line px-3 py-2 text-xs text-muted" disabled={busy !== null} onClick={() => call(`dec-${o.id}`, `/api/employer/offers/${o.id}`, 'PATCH', { organizationId, status: 'declined' })}>
                    Candidate declined
                  </button>
                  <button type="button" className="rounded-md border border-line px-3 py-2 text-xs text-danger" disabled={busy !== null} onClick={() => call(`wd-${o.id}`, `/api/employer/offers/${o.id}`, 'PATCH', { organizationId, status: 'withdrawn' })}>
                    Withdraw
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        {view.canOffer && view.disclosed && ['screening', 'interviewing'].includes(view.stage) ? (
          <form
            className="mt-3 flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              call('offer', `/api/employer/submissions/${view.id}/offers`, 'POST', { organizationId, salaryCents: salary ? Math.round(Number(salary) * 100) : null }, () => setSalary(''));
            }}
          >
            <label className="flex flex-col text-xs">
              <span className="text-muted">Annual salary (CAD)</span>
              <input type="number" min={0} className="rounded-md border border-line bg-surface px-3 py-2" value={salary} onChange={(e) => setSalary(e.target.value)} />
            </label>
            <button type="submit" className="btn-secondary text-xs" disabled={busy !== null}>
              Extend offer
            </button>
          </form>
        ) : null}
      </Card>
    </div>
  );
}
