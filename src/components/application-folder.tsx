'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarClock, CheckCircle2, CircleDashed, ClipboardList, Loader2, Mail, StickyNote, UserRound } from 'lucide-react';
import { Card, cn } from '@/components/ui';

/**
 * Stage 10 — the application folder: the timeline, the people, the
 * interviews, the assessments, the follow-ups, the notes and the outcome,
 * all on one record. Every write goes to a folder route on the tenant path
 * and is refused with a reason when it is not an honest move. Nothing here
 * contacts anyone: a follow-up is something the applicant did.
 */
export interface HistoryView {
  id: string;
  fromStatus: string;
  toStatus: string;
  actor: string;
  source: string;
  reason: string | null;
  atLabel: string;
}
export interface ContactView {
  id: string;
  role: string;
  name: string;
  email: string | null;
  phone: string | null;
  organisation: string | null;
  notes: string;
}
export interface InterviewView {
  id: string;
  kind: string;
  scheduledLabel: string;
  scheduledIso: string;
  location: string | null;
  interviewers: string[];
  outcome: string;
  result: string;
  notes: string;
}
export interface AssessmentView {
  id: string;
  kind: string;
  dueLabel: string | null;
  submittedLabel: string | null;
  result: string;
  notes: string;
}
export interface FollowUpView {
  id: string;
  dueLabel: string;
  doneLabel: string | null;
  channel: string;
  note: string;
  documentVersionId: string | null;
}
export interface NoteView {
  id: string;
  body: string;
  atLabel: string;
}
export interface MessageOption {
  id: string;
  label: string;
}
export interface AnswerView {
  question: string;
  label: string;
  ok: boolean;
  detail: string;
}
export interface OfferView {
  receivedLabel: string | null;
  deadlineLabel: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  currency: string | null;
  decision: string | null;
}

export interface ApplicationFolderProps {
  applicationId: string;
  status: string;
  outcome: string;
  rejectionReason: string | null;
  offer: OfferView;
  history: HistoryView[];
  contacts: ContactView[];
  interviews: InterviewView[];
  assessments: AssessmentView[];
  followUps: FollowUpView[];
  notes: NoteView[];
  messages: MessageOption[];
  answers: AnswerView[];
}

const label = (s: string) => s.replace(/_/g, ' ');

async function send(url: string, method: string, body?: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.ok) return { ok: true };
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: data.error ?? 'The change was refused.' };
  } catch {
    return { ok: false, error: 'The request could not be sent.' };
  }
}

function Section({ title, icon: Icon, children, form }: { title: string; icon: typeof Mail; children: React.ReactNode; form?: React.ReactNode }) {
  return (
    <Card className="p-5">
      <h2 className="mb-3 flex items-center gap-2 font-semibold text-ink">
        <Icon className="h-4 w-4 text-faint" aria-hidden="true" />
        {title}
      </h2>
      {children}
      {form && <div className="mt-4 border-t border-line pt-4">{form}</div>}
    </Card>
  );
}

export function ApplicationFolder(p: ApplicationFolderProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reached = ['submitted', 'interviewing', 'offer', 'rejected'].includes(p.status);
  const closed = ['rejected', 'withdrawn'].includes(p.status);

  async function submit(e: FormEvent<HTMLFormElement>, key: string, url: string, method: string, shape: (f: FormData) => unknown) {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(key);
    setError(null);
    const result = await send(url, method, shape(new FormData(form)));
    setBusy(null);
    if (!result.ok) {
      setError(result.error ?? null);
      return;
    }
    form.reset();
    router.refresh();
  }
  async function act(key: string, url: string, method: string, body?: unknown) {
    setBusy(key);
    setError(null);
    const result = await send(url, method, body);
    setBusy(null);
    if (!result.ok) setError(result.error ?? null);
    else router.refresh();
  }
  const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
  const opt = (f: FormData, k: string) => (str(f, k) ? str(f, k) : null);
  const iso = (f: FormData, k: string) => (str(f, k) ? new Date(str(f, k)).toISOString() : null);
  const base = `/api/applications/${p.applicationId}`;
  const answered = p.answers.filter((a) => a.ok).length;

  return (
    <div className="space-y-6">
      <p role="status" aria-live="polite" className="m-0 text-sm text-danger">
        {error}
      </p>

      {/* Completeness: what exactly was sent, to whom, when, how, and what happened */}
      <Card className={cn('p-5', answered === p.answers.length ? 'border-success/40' : '')}>
        <h2 className="mb-1 font-semibold text-ink">This folder answers {answered} of {p.answers.length} questions on its own</h2>
        <p className="mb-3 text-xs text-muted">What exactly was sent, to whom, when, how, and what happened — without any other system.</p>
        <ul className="grid gap-2 sm:grid-cols-2">
          {p.answers.map((a) => (
            <li key={a.question} className="flex items-start gap-2 text-sm">
              {a.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" /> : <CircleDashed className="mt-0.5 h-4 w-4 shrink-0 text-faint" aria-hidden="true" />}
              <span>
                <span className="font-medium text-ink">{a.label}</span> <span className="text-muted">— {a.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </Card>

      {/* Timeline */}
      <Section title="Timeline" icon={CalendarClock}>
        <ol className="space-y-1.5 text-sm">
          {p.history.map((h) => (
            <li key={h.id} className="flex flex-wrap gap-x-2 text-muted">
              <span className="font-mono text-xs text-faint">{h.atLabel}</span>
              <span>
                {h.fromStatus ? `${label(h.fromStatus)} → ` : 'created as '}
                <span className="font-medium text-ink">{label(h.toStatus)}</span>
                <span className="text-faint">
                  {' '}
                  · {h.actor === 'system' ? 'JobPilot' : 'you'} ({h.source}){h.reason ? ` — ${h.reason}` : ''}
                </span>
              </span>
            </li>
          ))}
          {p.history.length === 0 && <li className="text-muted">No status history recorded for this application (it predates the folder timeline).</li>}
        </ol>
        {(p.status === 'submitted' || p.status === 'interviewing') && (
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="btn-secondary px-3 py-1.5 text-xs" disabled={busy !== null} onClick={() => act('ghosted', `${base}/outcome`, 'PUT', { outcome: p.outcome === 'ghosted' ? 'pending' : 'ghosted' })}>
              {p.outcome === 'ghosted' ? 'Clear "no response"' : 'Mark: no response'}
            </button>
            <button type="button" className="btn-secondary px-3 py-1.5 text-xs" disabled={busy !== null} onClick={() => act('expired', `${base}/outcome`, 'PUT', { outcome: p.outcome === 'expired' ? 'pending' : 'expired' })}>
              {p.outcome === 'expired' ? 'Clear "posting expired"' : 'Mark: posting expired'}
            </button>
          </div>
        )}
        <p className="mt-2 text-xs text-faint">
          Outcome: <span className="font-medium text-ink">{label(p.outcome)}</span>
          {p.rejectionReason ? ` (${label(p.rejectionReason)})` : ''}
        </p>
      </Section>

      {/* Offer */}
      {(p.status === 'offer' || p.offer.decision) && (
        <Section
          title="Offer"
          icon={ClipboardList}
          form={
            p.status === 'offer' && (
              <form className="grid gap-2 sm:grid-cols-3" onSubmit={(e) => submit(e, 'offer', `${base}/offer`, 'PUT', (f) => ({ receivedAt: iso(f, 'receivedAt'), deadline: iso(f, 'deadline'), salaryMin: str(f, 'salaryMin') ? Number(str(f, 'salaryMin')) : null, salaryMax: str(f, 'salaryMax') ? Number(str(f, 'salaryMax')) : null, currency: opt(f, 'currency'), decision: str(f, 'decision') || 'pending' }))}>
                <label className="text-xs text-muted">
                  Received
                  <input name="receivedAt" type="date" className="input mt-1 w-full" />
                </label>
                <label className="text-xs text-muted">
                  Deadline
                  <input name="deadline" type="date" className="input mt-1 w-full" />
                </label>
                <label className="text-xs text-muted">
                  Currency
                  <input name="currency" maxLength={3} placeholder="CAD" className="input mt-1 w-full" />
                </label>
                <label className="text-xs text-muted">
                  Salary from
                  <input name="salaryMin" type="number" min={0} className="input mt-1 w-full" />
                </label>
                <label className="text-xs text-muted">
                  Salary to
                  <input name="salaryMax" type="number" min={0} className="input mt-1 w-full" />
                </label>
                <label className="text-xs text-muted">
                  Decision
                  <select name="decision" className="input mt-1 w-full" defaultValue={p.offer.decision ?? 'pending'}>
                    <option value="pending">Undecided</option>
                    <option value="accepted">Accepted</option>
                    <option value="declined">Declined</option>
                  </select>
                </label>
                <button type="submit" className="btn-primary sm:col-span-3 sm:justify-self-start" disabled={busy !== null}>
                  {busy === 'offer' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />} Save offer
                </button>
              </form>
            )
          }
        >
          <p className="text-sm text-muted">
            {p.offer.receivedLabel ? `Received ${p.offer.receivedLabel}. ` : 'Not yet recorded. '}
            {p.offer.deadlineLabel ? `Deadline ${p.offer.deadlineLabel}. ` : ''}
            {p.offer.salaryMin || p.offer.salaryMax ? `${p.offer.currency ?? ''} ${p.offer.salaryMin ?? '?'}–${p.offer.salaryMax ?? '?'}. ` : ''}
            {p.offer.decision ? `Decision: ${p.offer.decision}.` : ''}
          </p>
        </Section>
      )}

      {/* Contacts */}
      <Section
        title="People"
        icon={UserRound}
        form={
          !closed && (
            <form className="grid gap-2 sm:grid-cols-4" onSubmit={(e) => submit(e, 'contact', `${base}/contacts`, 'POST', (f) => ({ role: str(f, 'role'), name: str(f, 'name'), email: opt(f, 'email'), phone: opt(f, 'phone'), organisation: opt(f, 'organisation') }))}>
              <select name="role" className="input" defaultValue="recruiter" aria-label="Role">
                <option value="recruiter">Recruiter</option>
                <option value="hiring_manager">Hiring manager</option>
                <option value="referral">Referral</option>
                <option value="other">Other</option>
              </select>
              <input name="name" required placeholder="Name" className="input" aria-label="Name" />
              <input name="email" type="email" placeholder="Email (optional)" className="input" aria-label="Email" />
              <input name="organisation" placeholder="Organisation (optional)" className="input" aria-label="Organisation" />
              <button type="submit" className="btn-secondary sm:col-span-4 sm:justify-self-start" disabled={busy !== null}>
                {busy === 'contact' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />} Add contact
              </button>
            </form>
          )
        }
      >
        {p.contacts.length === 0 ? (
          <p className="text-sm text-muted">No named contact yet. The employer of record is on the role details.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {p.contacts.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-x-3 py-2">
                <span className="font-medium text-ink">{c.name}</span>
                <span className="chip">{label(c.role)}</span>
                {c.organisation && <span className="text-muted">{c.organisation}</span>}
                {c.email && (
                  <a href={`mailto:${c.email}`} className="text-brand-600 hover:underline">
                    {c.email}
                  </a>
                )}
                {c.phone && <span className="text-muted">{c.phone}</span>}
                <button type="button" className="btn-ghost ml-auto px-2 py-1 text-xs" disabled={busy !== null} onClick={() => act(`rm:${c.id}`, `${base}/contacts/${c.id}`, 'DELETE')}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Interviews */}
      <Section
        title="Interviews"
        icon={CalendarClock}
        form={
          reached &&
          !closed && (
            <form className="grid gap-2 sm:grid-cols-4" onSubmit={(e) => submit(e, 'interview', `${base}/interviews`, 'POST', (f) => ({ kind: str(f, 'kind'), scheduledAt: iso(f, 'scheduledAt'), location: opt(f, 'location'), interviewers: str(f, 'interviewers') ? str(f, 'interviewers').split(',').map((s) => s.trim()).filter(Boolean) : [] }))}>
              <select name="kind" className="input" defaultValue="video" aria-label="Kind">
                {['phone', 'video', 'onsite', 'panel', 'technical', 'other'].map((k) => (
                  <option key={k} value={k}>
                    {label(k)}
                  </option>
                ))}
              </select>
              <input name="scheduledAt" type="datetime-local" required className="input" aria-label="When" />
              <input name="location" placeholder="Link or address" className="input" aria-label="Location" />
              <input name="interviewers" placeholder="Interviewers, comma-separated" className="input" aria-label="Interviewers" />
              <button type="submit" className="btn-secondary sm:col-span-4 sm:justify-self-start" disabled={busy !== null}>
                {busy === 'interview' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />} Add interview
              </button>
            </form>
          )
        }
      >
        {p.interviews.length === 0 ? (
          <p className="text-sm text-muted">{reached ? 'None recorded. Adding the first one moves the application to interviewing.' : 'Available once the application has reached the employer.'}</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {p.interviews.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-x-3 py-2">
                <span className="font-medium text-ink">{label(i.kind)}</span>
                <span className="text-muted">{i.scheduledLabel}</span>
                {i.location && <span className="truncate text-muted">{i.location}</span>}
                {i.interviewers.length > 0 && <span className="text-faint">with {i.interviewers.join(', ')}</span>}
                <span className="chip">{label(i.outcome)}</span>
                <span className={cn('chip', i.result === 'advanced' ? 'bg-success/10 text-success' : i.result === 'not_advanced' ? 'bg-danger/10 text-danger' : '')}>{label(i.result)}</span>
                {i.outcome === 'scheduled' && (
                  <span className="ml-auto flex gap-1">
                    <button type="button" className="btn-ghost px-2 py-1 text-xs" disabled={busy !== null} onClick={() => act(`iv:${i.id}`, `${base}/interviews/${i.id}`, 'PATCH', { outcome: 'completed', result: 'advanced' })}>
                      Advanced
                    </button>
                    <button type="button" className="btn-ghost px-2 py-1 text-xs" disabled={busy !== null} onClick={() => act(`iv:${i.id}`, `${base}/interviews/${i.id}`, 'PATCH', { outcome: 'completed', result: 'not_advanced' })}>
                      Not advanced
                    </button>
                    <button type="button" className="btn-ghost px-2 py-1 text-xs" disabled={busy !== null} onClick={() => act(`iv:${i.id}`, `${base}/interviews/${i.id}`, 'PATCH', { outcome: 'cancelled' })}>
                      Cancelled
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Assessments */}
      <Section
        title="Assessments"
        icon={ClipboardList}
        form={
          reached &&
          !closed && (
            <form className="grid gap-2 sm:grid-cols-3" onSubmit={(e) => submit(e, 'assessment', `${base}/assessments`, 'POST', (f) => ({ kind: str(f, 'kind'), dueAt: iso(f, 'dueAt') }))}>
              <select name="kind" className="input" defaultValue="take_home" aria-label="Kind">
                {['take_home', 'online_test', 'case_study', 'presentation', 'other'].map((k) => (
                  <option key={k} value={k}>
                    {label(k)}
                  </option>
                ))}
              </select>
              <input name="dueAt" type="datetime-local" className="input" aria-label="Due" />
              <button type="submit" className="btn-secondary sm:justify-self-start" disabled={busy !== null}>
                {busy === 'assessment' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />} Add assessment
              </button>
            </form>
          )
        }
      >
        {p.assessments.length === 0 ? (
          <p className="text-sm text-muted">None recorded.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {p.assessments.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-x-3 py-2">
                <span className="font-medium text-ink">{label(a.kind)}</span>
                {a.dueLabel && <span className="text-muted">due {a.dueLabel}</span>}
                {a.submittedLabel && <span className="text-muted">submitted {a.submittedLabel}</span>}
                <span className="chip">{a.result}</span>
                {a.result === 'pending' && (
                  <span className="ml-auto flex gap-1">
                    {!a.submittedLabel && (
                      <button type="button" className="btn-ghost px-2 py-1 text-xs" disabled={busy !== null} onClick={() => act(`as:${a.id}`, `${base}/assessments/${a.id}`, 'PATCH', { submittedAt: new Date().toISOString() })}>
                        Submitted
                      </button>
                    )}
                    <button type="button" className="btn-ghost px-2 py-1 text-xs" disabled={busy !== null} onClick={() => act(`as:${a.id}`, `${base}/assessments/${a.id}`, 'PATCH', { result: 'passed' })}>
                      Passed
                    </button>
                    <button type="button" className="btn-ghost px-2 py-1 text-xs" disabled={busy !== null} onClick={() => act(`as:${a.id}`, `${base}/assessments/${a.id}`, 'PATCH', { result: 'failed' })}>
                      Failed
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Follow-ups */}
      <Section
        title="Follow-ups"
        icon={Mail}
        form={
          !closed && (
            <form className="grid gap-2 sm:grid-cols-4" onSubmit={(e) => submit(e, 'followup', `${base}/follow-ups`, 'POST', (f) => ({ dueAt: iso(f, 'dueAt'), channel: str(f, 'channel'), note: str(f, 'note'), documentVersionId: opt(f, 'documentVersionId') }))}>
              <input name="dueAt" type="date" required className="input" aria-label="Due" />
              <select name="channel" className="input" defaultValue="email" aria-label="Channel">
                {['email', 'phone', 'linkedin', 'portal', 'other'].map((k) => (
                  <option key={k} value={k}>
                    {label(k)}
                  </option>
                ))}
              </select>
              <input name="note" placeholder="What you plan to say" className="input" aria-label="Note" />
              <select name="documentVersionId" className="input" defaultValue="" aria-label="Drafted message">
                <option value="">No drafted message</option>
                {p.messages.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              <button type="submit" className="btn-secondary sm:col-span-4 sm:justify-self-start" disabled={busy !== null}>
                {busy === 'followup' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />} Plan follow-up
              </button>
            </form>
          )
        }
      >
        <p className="mb-2 text-xs text-faint">You send follow-ups yourself; JobPilot records that you did, and never contacts anyone.</p>
        {p.followUps.length === 0 ? (
          <p className="text-sm text-muted">None planned.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {p.followUps.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-x-3 py-2">
                <span className="font-medium text-ink">{label(f.channel)}</span>
                <span className="text-muted">due {f.dueLabel}</span>
                {f.note && <span className="text-muted">{f.note}</span>}
                {f.documentVersionId && (
                  <a href={`/api/documents/${f.documentVersionId}`} className="text-brand-600 hover:underline">
                    drafted message
                  </a>
                )}
                {f.doneLabel ? (
                  <span className="chip bg-success/10 text-success">done {f.doneLabel}</span>
                ) : (
                  <button type="button" className="btn-ghost ml-auto px-2 py-1 text-xs" disabled={busy !== null} onClick={() => act(`fu:${f.id}`, `${base}/follow-ups/${f.id}`, 'PATCH', { done: true })}>
                    Mark done
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Notes */}
      <Section
        title="Notes"
        icon={StickyNote}
        form={
          <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => submit(e, 'note', `${base}/notes`, 'POST', (f) => ({ body: str(f, 'body') }))}>
            <input name="body" required maxLength={10000} placeholder="Add a note" className="input flex-1" aria-label="Note" />
            <button type="submit" className="btn-secondary" disabled={busy !== null}>
              {busy === 'note' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />} Add
            </button>
          </form>
        }
      >
        {p.notes.length === 0 ? (
          <p className="text-sm text-muted">No notes yet.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {p.notes.map((n) => (
              <li key={n.id}>
                <p className="whitespace-pre-wrap text-ink">{n.body}</p>
                <p className="text-xs text-faint">{n.atLabel}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
