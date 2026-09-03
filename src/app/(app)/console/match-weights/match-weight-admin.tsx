'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { Card, cn } from '@/components/ui';

export interface WeightVersionView {
  id: string;
  version: number;
  status: string;
  weights: string;
  notes: string;
  createdByEmail: string | null;
  approvedByEmail: string | null;
  updatedAt: string;
}
export interface WeightAuditView {
  id: string;
  action: string;
  summary: string;
  actorEmail: string;
  reason: string | null;
  createdAt: string;
}
type Weights = { skills: number; keywords: number; experience: number; seniority: number; location: number };

const DIMENSION_LABELS: Record<keyof Weights, string> = { skills: 'Skills overlap', keywords: 'Keyword density', experience: 'Years of experience', seniority: 'Seniority alignment', location: 'Location fit' };
const STATUS_TONE: Record<string, string> = { active: 'bg-success/10 text-success', approved: 'bg-brand-500/10 text-brand-600', draft: 'bg-raised text-muted', retired: 'bg-raised text-muted line-through' };

function parse(json: string): Weights | null {
  try {
    return JSON.parse(json) as Weights;
  } catch {
    return null;
  }
}

export function MatchWeightAdmin({ versions, active, builtin, audit }: { versions: WeightVersionView[]; active: { version: string; weights: Weights }; builtin: { version: string; weights: Weights }; audit: WeightAuditView[] }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [draft, setDraft] = useState<{ weights: Weights; notes: string }>({ weights: { ...active.weights }, notes: '' });
  const sum = Object.values(draft.weights).reduce((a, b) => a + b, 0);

  async function send(url: string, method: string, body: Record<string, unknown>, label: string) {
    if (!password) {
      setMessage({ ok: false, text: 'Enter your current password first — every weight change is re-authenticated.' });
      return;
    }
    setBusy(label);
    setMessage(null);
    try {
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: password, reason: reason || undefined, ...body }) });
      const data = (await res.json()) as { error?: string; version?: { version: number; status: string } };
      if (!res.ok) {
        setMessage({ ok: false, text: data.error ?? 'The change was refused.' });
        if (res.status === 403) setPassword('');
      } else {
        setMessage({ ok: true, text: `Weights v${data.version?.version} are now ${data.version?.status}.` });
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
      <p role="status" aria-live="polite" className={cn('m-0 flex items-center gap-1 text-sm', message?.ok ? 'text-success' : 'text-danger')}>
        {message && (
          <>
            {message.ok ? <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> : <AlertCircle className="h-4 w-4" aria-hidden="true" />}
            {message.text}
          </>
        )}
      </p>

      <Card className="p-5">
        <h2 className="font-semibold text-ink">Scoring now with {active.version === builtin.version ? 'the built-in baseline' : `v${active.version.replace(/^v/, '')}`}</h2>
        <dl className="mt-2 grid gap-1 text-sm sm:grid-cols-5">
          {(Object.keys(DIMENSION_LABELS) as (keyof Weights)[]).map((k) => (
            <div key={k}>
              <dt className="text-muted">{DIMENSION_LABELS[k]}</dt>
              <dd className="font-medium tabular-nums text-ink">{Math.round(active.weights[k] * 100)}%</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-xs text-faint">
          The built-in baseline ({builtin.version}) applies whenever no version is active. Weights must sum to 100%.
        </p>
      </Card>

      <Card className="p-5">
        <h2 className="font-semibold text-ink">Re-authenticate</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="font-medium text-ink">Current password</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" className="input mt-1 w-full" />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-ink">Reason (recorded in the audit)</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} className="input mt-1 w-full" />
          </label>
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="font-semibold text-ink">New draft version</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-5">
          {(Object.keys(DIMENSION_LABELS) as (keyof Weights)[]).map((k) => (
            <label key={k} className="block text-sm">
              <span className="font-medium text-ink">{DIMENSION_LABELS[k]}</span>
              <input
                type="number"
                min={0}
                max={100}
                step={1}
                value={Math.round(draft.weights[k] * 100)}
                onChange={(e) => setDraft({ ...draft, weights: { ...draft.weights, [k]: Number(e.target.value) / 100 } })}
                className="input mt-1 w-full"
                aria-label={`${DIMENSION_LABELS[k]} weight, percent`}
              />
            </label>
          ))}
        </div>
        <p className={cn('mt-2 text-xs', Math.abs(sum - 1) > 0.001 ? 'text-danger' : 'text-faint')}>Sum: {Math.round(sum * 100)}%{Math.abs(sum - 1) > 0.001 ? ' — must be 100%' : ''}</p>
        <label className="mt-3 block text-sm">
          <span className="font-medium text-ink">Notes</span>
          <textarea value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} rows={2} className="input mt-1 w-full" />
        </label>
        <button type="button" className="btn-primary mt-3" disabled={busy !== null || Math.abs(sum - 1) > 0.001} onClick={() => send('/api/console/match-weights', 'POST', { weights: draft.weights, notes: draft.notes }, 'create')}>
          {busy === 'create' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />} Create draft
        </button>
      </Card>

      <div className="space-y-3">
        {versions.length === 0 && <p className="text-sm text-muted">No versions yet: the built-in baseline is scoring every match.</p>}
        {versions.map((v) => {
          const w = parse(v.weights);
          return (
            <Card key={v.id} className="p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-semibold text-ink">v{v.version}</span>{' '}
                  <span className={cn('chip', STATUS_TONE[v.status] ?? 'bg-raised text-muted')}>{v.status}</span>
                </div>
                <span className="text-xs text-faint">
                  by {v.createdByEmail ?? 'unknown'}
                  {v.approvedByEmail ? `, approved by ${v.approvedByEmail}` : ''}
                </span>
              </div>
              {w && (
                <p className="mt-2 text-sm text-muted">
                  {(Object.keys(DIMENSION_LABELS) as (keyof Weights)[]).map((k) => `${DIMENSION_LABELS[k]} ${Math.round(w[k] * 100)}%`).join(' · ')}
                </p>
              )}
              {v.notes && <p className="mt-1 text-xs text-muted">{v.notes}</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                {v.status === 'draft' && (
                  <button type="button" className="btn-secondary px-3 py-1.5 text-xs" disabled={busy !== null} onClick={() => send(`/api/console/match-weights/${v.id}`, 'PATCH', { action: 'approve' }, `approve:${v.id}`)}>
                    {busy === `approve:${v.id}` && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />} Approve (second admin)
                  </button>
                )}
                {v.status === 'approved' && (
                  <button type="button" className="btn-primary px-3 py-1.5 text-xs" disabled={busy !== null} onClick={() => send(`/api/console/match-weights/${v.id}`, 'PATCH', { action: 'activate' }, `activate:${v.id}`)}>
                    {busy === `activate:${v.id}` && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />} Activate
                  </button>
                )}
                {v.status !== 'active' && v.status !== 'retired' && (
                  <button type="button" className="btn-secondary px-3 py-1.5 text-xs" disabled={busy !== null} onClick={() => send(`/api/console/match-weights/${v.id}`, 'PATCH', { action: 'retire' }, `retire:${v.id}`)}>
                    {busy === `retire:${v.id}` && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />} Retire
                  </button>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      <Card className="p-5">
        <h2 className="font-semibold text-ink">Audit</h2>
        {audit.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No changes yet.</p>
        ) : (
          <ul className="mt-2 space-y-1.5 text-sm">
            {audit.map((a) => (
              <li key={a.id} className="text-muted">
                <span className="text-faint">{new Date(a.createdAt).toLocaleString('en-CA')}</span> · <span className="font-medium text-ink">{a.action}</span> · {a.summary} — {a.actorEmail}
                {a.reason ? ` (${a.reason})` : ''}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
