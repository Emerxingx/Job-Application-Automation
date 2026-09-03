'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { Card, cn } from '@/components/ui';

export interface PromptVersionView {
  id: string;
  slug: string;
  version: number;
  modelProvider: string;
  targetModel: string;
  deploymentStatus: string;
  evaluationStatus: string;
  evaluationNote: string;
  systemPrompt: string;
  userPromptTemplate: string | null;
  requiredVariables: string;
  modelParameters: string;
  createdByEmail: string;
  approvedByEmail: string | null;
  approvedAt: string | null;
  updatedAt: string;
  notes: string;
}

export interface PromptAuditView {
  id: string;
  action: string;
  summary: string;
  actorEmail: string;
  reason: string | null;
  createdAt: string;
}

const STATUS_TONE: Record<string, string> = {
  default: 'bg-success/10 text-success',
  approved: 'bg-brand-500/10 text-brand-600',
  draft: 'bg-raised text-muted',
  retired: 'bg-raised text-muted line-through',
};
const EVAL_TONE: Record<string, string> = {
  passed: 'text-success',
  failed: 'text-danger',
  pending: 'text-muted',
};

type Action =
  | { action: 'approve' }
  | { action: 'promote' }
  | { action: 'retire' }
  | { action: 'evaluate'; status: 'passed' | 'failed' | 'pending'; note: string };

/**
 * Every mutation asks for the admin's current password in the same form
 * (step-up), and a reason. The list re-renders from the server after each
 * change so the badges and the audit feed never drift from the database.
 */
export function PromptAdmin({ versions, audit }: { versions: PromptVersionView[]; audit: PromptAuditView[] }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [evalNote, setEvalNote] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(null);

  const bySlug = useMemo(() => {
    const map = new Map<string, PromptVersionView[]>();
    for (const v of versions) map.set(v.slug, [...(map.get(v.slug) ?? []), v]);
    return [...map.entries()];
  }, [versions]);

  async function act(id: string, body: Action) {
    if (!password) {
      setMessage({ ok: false, text: 'Enter your current password first — every prompt change is re-authenticated.' });
      return;
    }
    setBusy(`${id}:${body.action}`);
    setMessage(null);
    try {
      const res = await fetch(`/api/console/prompts/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: password, reason: reason || undefined, ...body }),
      });
      const data = (await res.json()) as { error?: string; version?: { slug: string; version: number; deploymentStatus: string } };
      if (!res.ok) {
        setMessage({ ok: false, text: data.error ?? 'The change was refused.' });
      } else {
        setMessage({ ok: true, text: `${data.version?.slug} v${data.version?.version} is now ${data.version?.deploymentStatus}.` });
        router.refresh();
      }
    } catch {
      setMessage({ ok: false, text: 'The request could not be sent.' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <h2 className="text-base font-semibold text-ink">Re-authentication</h2>
        <p className="mt-1 text-sm text-muted">
          Approving, evaluating, promoting, rolling back or retiring a version requires your current password. It is sent only
          with the change and never stored in the page.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="font-medium text-ink">Current password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input mt-1 w-full"
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-ink">Reason (recorded in the audit log)</span>
            <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} className="input mt-1 w-full" />
          </label>
        </div>
        <p role="status" aria-live="polite" className={cn('mt-3 flex items-center gap-1 text-sm', message?.ok ? 'text-success' : 'text-danger')}>
          {message && (
            <>
              {message.ok ? <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> : <AlertCircle className="h-4 w-4" aria-hidden="true" />}
              {message.text}
            </>
          )}
        </p>
      </Card>

      {bySlug.map(([slug, list]) => {
        const current = list.find((v) => v.deploymentStatus === 'default');
        return (
          <Card key={slug}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-base font-semibold text-ink">
                <code>{slug}</code>
              </h2>
              <p className="text-sm text-muted">
                {current ? `Serving v${current.version}` : 'No default — the gateway serves the deterministic engine for this task.'}
              </p>
            </div>
            <ul className="mt-3 divide-y divide-line">
              {list.map((v) => {
                const canPromote = v.deploymentStatus === 'approved' && v.evaluationStatus === 'passed';
                const isRollback = canPromote && current !== undefined && v.version < current.version;
                return (
                  <li key={v.id} className="py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-ink">v{v.version}</span>
                      <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', STATUS_TONE[v.deploymentStatus] ?? STATUS_TONE.draft)}>
                        {v.deploymentStatus}
                      </span>
                      <span className={cn('text-xs', EVAL_TONE[v.evaluationStatus] ?? 'text-muted')}>evaluation: {v.evaluationStatus}</span>
                      <span className="text-xs text-muted">
                        {v.modelProvider} · {v.targetModel}
                      </span>
                      <button type="button" className="ml-auto text-xs text-brand-500 hover:text-brand-600" onClick={() => setOpen(open === v.id ? null : v.id)} aria-expanded={open === v.id}>
                        {open === v.id ? 'Hide prompt' : 'Show prompt'}
                      </button>
                    </div>
                    {v.evaluationNote && <p className="mt-1 text-xs text-muted">Evaluation note: {v.evaluationNote}</p>}
                    <p className="mt-1 text-xs text-muted">
                      Created by {v.createdByEmail || 'system'}
                      {v.approvedByEmail ? ` · approved by ${v.approvedByEmail}` : ''}
                    </p>
                    {open === v.id && (
                      <div className="mt-2 space-y-2 text-xs">
                        <p className="font-medium text-ink">System prompt</p>
                        <pre className="whitespace-pre-wrap rounded-lg bg-raised p-3 text-ink">{v.systemPrompt}</pre>
                        {v.userPromptTemplate && (
                          <>
                            <p className="font-medium text-ink">User prompt template</p>
                            <pre className="whitespace-pre-wrap rounded-lg bg-raised p-3 text-ink">{v.userPromptTemplate}</pre>
                          </>
                        )}
                        <p className="text-muted">
                          Variables: <code>{v.requiredVariables}</code> · Parameters: <code>{v.modelParameters}</code>
                        </p>
                      </div>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {v.deploymentStatus === 'draft' && (
                        <button type="button" className="btn-secondary px-3 py-1.5 text-xs" disabled={busy !== null} onClick={() => act(v.id, { action: 'approve' })}>
                          {busy === `${v.id}:approve` && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />} Approve
                        </button>
                      )}
                      {v.deploymentStatus !== 'retired' && (
                        <>
                          <label className="text-xs text-muted">
                            <span className="sr-only">Evaluation note for v{v.version}</span>
                            <input
                              type="text"
                              placeholder="Evaluation note (what ran, on what, the result)"
                              value={evalNote[v.id] ?? ''}
                              onChange={(e) => setEvalNote({ ...evalNote, [v.id]: e.target.value })}
                              className="input w-72 max-w-full px-2 py-1 text-xs"
                            />
                          </label>
                          <button type="button" className="btn-secondary px-3 py-1.5 text-xs" disabled={busy !== null} onClick={() => act(v.id, { action: 'evaluate', status: 'passed', note: evalNote[v.id] ?? '' })}>
                            Record pass
                          </button>
                          <button type="button" className="btn-secondary px-3 py-1.5 text-xs" disabled={busy !== null} onClick={() => act(v.id, { action: 'evaluate', status: 'failed', note: evalNote[v.id] ?? '' })}>
                            Record fail
                          </button>
                        </>
                      )}
                      {canPromote && (
                        <button type="button" className="btn-primary px-3 py-1.5 text-xs" disabled={busy !== null} onClick={() => act(v.id, { action: 'promote' })}>
                          {busy === `${v.id}:promote` && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />} {isRollback ? 'Roll back to this version' : 'Promote to default'}
                        </button>
                      )}
                      {v.deploymentStatus === 'approved' && v.evaluationStatus !== 'passed' && (
                        <span className="text-xs text-muted">Cannot promote until an evaluation pass is recorded.</span>
                      )}
                      {v.deploymentStatus !== 'default' && v.deploymentStatus !== 'retired' && (
                        <button type="button" className="text-xs text-muted hover:text-danger" disabled={busy !== null} onClick={() => act(v.id, { action: 'retire' })}>
                          Retire
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        );
      })}

      <Card>
        <h2 className="text-base font-semibold text-ink">Audit trail</h2>
        {audit.length === 0 ? (
          <p className="mt-1 text-sm text-muted">No prompt changes have been recorded yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-line text-sm">
            {audit.map((a) => (
              <li key={a.id} className="py-2">
                <span className="font-mono text-xs text-muted">{a.action}</span> <span className="text-ink">{a.summary}</span>
                <span className="block text-xs text-muted">
                  {a.actorEmail} · {new Date(a.createdAt).toLocaleString('en-CA')}
                  {a.reason ? ` · ${a.reason}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
