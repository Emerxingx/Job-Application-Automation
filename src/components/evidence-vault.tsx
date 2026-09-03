'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, CheckCircle2, Loader2, RefreshCw } from 'lucide-react';
import { Card, cn } from '@/components/ui';

export interface EvidenceView {
  id: string;
  kind: string;
  sourceType: string;
  claim: string;
  status: string;
  version: number;
  supersedesId: string | null;
  approvedAt: string | null;
  updatedAt: string;
}

export interface QuestionView {
  id: string;
  question: string;
  category: string;
  riskLevel: string;
  policy: string;
  answer: string;
  lastConfirmedAt: string | null;
  answerUpdatedAt: string | null;
}

const KIND_LABEL: Record<string, string> = {
  employment: 'Employment',
  responsibility: 'Responsibilities and results',
  achievement: 'Achievements',
  education: 'Education',
  certification: 'Certifications',
  skill: 'Skills',
  project: 'Projects',
  language: 'Languages',
};
const KIND_ORDER = Object.keys(KIND_LABEL);

const STATUS_TONE: Record<string, string> = {
  approved: 'bg-success/10 text-success',
  draft: 'bg-warn/10 text-warn',
  superseded: 'bg-raised text-muted',
  revoked: 'bg-raised text-muted line-through',
};

const POLICY_LABEL: Record<string, string> = {
  AUTO_FILL: 'Fill automatically',
  ASK_IF_CHANGED: 'Fill, confirm if changed',
  REQUIRE_REVIEW: 'Always review',
  NEVER_AUTOMATE: 'Never automated',
};

/**
 * Two lists, one page. Every control is labelled; the status regions are
 * live so a screen reader hears "Saved" and errors without focus moving.
 * Nothing here submits an application (ADR-0016): the policy column says
 * what an assisted application MAY do with an answer in Stage 12.
 */
export function EvidenceVault({ evidence, questions }: { evidence: EvidenceView[]; questions: QuestionView[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [manual, setManual] = useState({ kind: 'achievement', claim: '' });
  const [q, setQ] = useState({ question: '', answer: '', policy: '' });

  const grouped = useMemo(() => {
    const visible = evidence.filter((e) => showAll || e.status === 'approved' || e.status === 'draft');
    const map = new Map<string, EvidenceView[]>();
    for (const e of visible) map.set(e.kind, [...(map.get(e.kind) ?? []), e]);
    return KIND_ORDER.filter((k) => map.has(k)).map((k) => [k, map.get(k)!] as const);
  }, [evidence, showAll]);

  const approvedCount = evidence.filter((e) => e.status === 'approved').length;
  const draftCount = evidence.filter((e) => e.status === 'draft').length;

  async function call(label: string, url: string, init: RequestInit, done: string) {
    setBusy(label);
    setStatus(null);
    try {
      const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init });
      const data = (await res.json().catch(() => ({}))) as { error?: string; report?: Record<string, number> };
      if (!res.ok) setStatus({ ok: false, text: data.error ?? 'That did not work.' });
      else {
        const r = data.report;
        setStatus({ ok: true, text: r ? `${done}: ${r.created} added, ${r.superseded} updated, ${r.revoked} removed, ${r.unchanged} unchanged.` : done });
        router.refresh();
      }
    } catch {
      setStatus({ ok: false, text: 'The request could not be sent.' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn-primary" disabled={busy !== null} onClick={() => call('sync', '/api/evidence/sync', { method: 'POST' }, 'Vault updated from your profile')}>
          {busy === 'sync' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
          Update from my resume
        </button>
        <p className="m-0 text-sm text-muted">
          {approvedCount} approved · {draftCount} awaiting your approval
        </p>
        <label className="ml-auto flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          Show superseded and revoked
        </label>
      </div>
      <p role="status" aria-live="polite" className={cn('m-0 flex items-center gap-1 text-sm', status?.ok ? 'text-success' : 'text-danger')}>
        {status && (
          <>
            {status.ok ? <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> : <AlertCircle className="h-4 w-4" aria-hidden="true" />}
            {status.text}
          </>
        )}
      </p>

      {grouped.length === 0 ? (
        <Card>
          <p className="text-sm text-muted">
            Nothing here yet. Add your resume, then press <strong>Update from my resume</strong> to turn each role, result, credential and skill into an evidence item.
          </p>
        </Card>
      ) : (
        grouped.map(([kind, items]) => (
          <Card key={kind}>
            <h2 className="text-base font-semibold text-ink">{KIND_LABEL[kind] ?? kind}</h2>
            <ul className="mt-2 divide-y divide-line">
              {items.map((e) => (
                <li key={e.id} className="flex flex-wrap items-start gap-2 py-2 text-sm">
                  <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', STATUS_TONE[e.status] ?? STATUS_TONE.draft)}>{e.status}</span>
                  <span className="min-w-0 flex-1 text-ink">{e.claim}</span>
                  <span className="text-xs text-muted">
                    v{e.version} · {e.sourceType.replace('profile_', 'from profile: ')}
                  </span>
                  {e.status === 'draft' && (
                    <button type="button" className="btn-secondary px-2 py-1 text-xs" disabled={busy !== null} onClick={() => call(e.id, `/api/evidence/${e.id}`, { method: 'PATCH', body: JSON.stringify({ action: 'approve' }) }, 'Approved')}>
                      Approve
                    </button>
                  )}
                  {(e.status === 'draft' || e.status === 'approved') && (
                    <button type="button" className="text-xs text-muted hover:text-danger" disabled={busy !== null} onClick={() => call(e.id, `/api/evidence/${e.id}`, { method: 'PATCH', body: JSON.stringify({ action: 'revoke' }) }, 'Revoked')}>
                      Revoke
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        ))
      )}

      <Card>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            call('manual', '/api/evidence', { method: 'POST', body: JSON.stringify(manual) }, 'Added as a draft — approve it above when you are sure').then(() => setManual({ ...manual, claim: '' }));
          }}
        >
          <fieldset>
            <legend className="text-base font-semibold text-ink">Add a claim by hand</legend>
            <p className="mt-1 text-sm text-muted">
              For something your resume does not carry yet — a result, a credential, a project. It starts as a draft and grounds nothing until you approve it.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-[10rem_1fr]">
              <label className="block text-sm">
                <span className="font-medium text-ink">Kind</span>
                <select value={manual.kind} onChange={(e) => setManual({ ...manual, kind: e.target.value })} className="input mt-1 w-full">
                  {KIND_ORDER.map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABEL[k]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                <span className="font-medium text-ink">Claim (one sentence)</span>
                <input type="text" required minLength={3} maxLength={500} value={manual.claim} onChange={(e) => setManual({ ...manual, claim: e.target.value })} className="input mt-1 w-full" />
              </label>
            </div>
            <button type="submit" className="btn-secondary mt-3" disabled={busy !== null}>
              Add draft
            </button>
          </fieldset>
        </form>
      </Card>

      <Card>
        <h2 className="text-base font-semibold text-ink">Application questions</h2>
        <p className="mt-1 text-sm text-muted">
          Answers you want to reuse across applications. JobPilot classifies each question and sets the least automation it permits: questions about
          protected characteristics, health, age or a criminal record are never automated, whatever you choose, and nothing on this page submits
          anything.
        </p>
        <form
          className="mt-3 grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            call('question', '/api/questions', { method: 'POST', body: JSON.stringify({ question: q.question, answer: q.answer, policy: q.policy || null }) }, 'Question saved').then(() => setQ({ question: '', answer: '', policy: '' }));
          }}
        >
          <label className="block text-sm sm:col-span-2">
            <span className="font-medium text-ink">Question, as the employer asks it</span>
            <input type="text" required minLength={3} maxLength={1000} value={q.question} onChange={(e) => setQ({ ...q, question: e.target.value })} className="input mt-1 w-full" />
          </label>
          <label className="block text-sm sm:col-span-2">
            <span className="font-medium text-ink">Your answer</span>
            <textarea rows={3} maxLength={4000} value={q.answer} onChange={(e) => setQ({ ...q, answer: e.target.value })} className="input mt-1 w-full" />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-ink">Automation you would allow</span>
            <select value={q.policy} onChange={(e) => setQ({ ...q, policy: e.target.value })} className="input mt-1 w-full">
              <option value="">Let JobPilot decide</option>
              {Object.entries(POLICY_LABEL).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-end">
            <button type="submit" className="btn-secondary" disabled={busy !== null}>
              Save question
            </button>
          </div>
        </form>
        {questions.length > 0 && (
          <ul className="mt-4 divide-y divide-line">
            {questions.map((it) => (
              <li key={it.id} className="py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-ink">{it.question}</span>
                  <span className="rounded-full bg-raised px-2 py-0.5 text-xs text-muted">{it.category}</span>
                  <span className={cn('rounded-full px-2 py-0.5 text-xs', it.policy === 'NEVER_AUTOMATE' ? 'bg-danger/10 text-danger' : 'bg-brand-500/10 text-brand-600')}>
                    {POLICY_LABEL[it.policy] ?? it.policy}
                  </span>
                  <button type="button" className="ml-auto text-xs text-muted hover:text-danger" disabled={busy !== null} onClick={() => call(it.id, `/api/questions/${it.id}`, { method: 'DELETE' }, 'Question removed')}>
                    Remove
                  </button>
                </div>
                {it.answer && <p className="mt-1 whitespace-pre-wrap text-muted">{it.answer}</p>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
