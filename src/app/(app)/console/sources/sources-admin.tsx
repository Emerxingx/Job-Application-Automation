'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { Card, cn } from '@/components/ui';

export interface SourceView {
  key: string;
  name: string;
  kind: string;
  priority: number;
  status: string;
  legalBasis: string;
  termsReviewedAt: string | null;
  termsReviewedByEmail: string | null;
  robotsPosition: string;
  rateLimitPerMinute: number;
  attributionRequired: boolean;
  attributionText: string;
  dataCategories: string;
  personalData: boolean;
  retentionRef: string;
  approvedAt: string | null;
  approvedByEmail: string | null;
  credentialEnvVars: string;
  missingCredentials: string[];
  recordComplete: boolean;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastHealthAt: string | null;
  lastHealthStatus: string;
  lastError: string | null;
  errorCount: number;
  notes: string;
}

export interface SourceRunView {
  id: string;
  sourceKey: string;
  kind: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  discovered: number;
  created: number;
  updated: number;
  closed: number;
  rejected: number;
  error: string | null;
}

const STATUS_TONE: Record<string, string> = { enabled: 'bg-success/10 text-success', degraded: 'bg-warn/10 text-warn', disabled: 'bg-raised text-muted' };
const HEALTH_TONE: Record<string, string> = { ok: 'text-success', degraded: 'text-warn', down: 'text-danger', unknown: 'text-muted' };

export function SourcesAdmin({ sources, runs }: { sources: SourceView[]; runs: SourceRunView[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ currentPassword: '', action: 'record', legalBasis: '', robotsPosition: '', rateLimitPerMinute: '0', attributionRequired: false, attributionText: '', retentionRef: '', reason: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  function startEdit(s: SourceView) {
    setEditing(s.key);
    setForm({ currentPassword: '', action: s.status === 'disabled' ? 'enable' : 'record', legalBasis: s.legalBasis, robotsPosition: s.robotsPosition, rateLimitPerMinute: String(s.rateLimitPerMinute), attributionRequired: s.attributionRequired, attributionText: s.attributionText, retentionRef: s.retentionRef, reason: '' });
  }

  async function submit(key: string) {
    setBusy(key);
    setMessage(null);
    try {
      const res = await fetch(`/api/console/sources/${key}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, rateLimitPerMinute: Number(form.rateLimitPerMinute) || 0 }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setMessage({ ok: false, text: data.error ?? 'The change was refused.' });
        if (res.status === 403) setForm({ ...form, currentPassword: '' });
      } else {
        setMessage({ ok: true, text: `${key}: ${form.action === 'enable' ? 'enabled' : form.action === 'disable' ? 'disabled' : 'record saved'}.` });
        setEditing(null);
        router.refresh();
      }
    } catch {
      setMessage({ ok: false, text: 'The request could not be sent.' });
    } finally {
      setBusy(null);
    }
  }

  async function health(key: string) {
    setBusy(`health:${key}`);
    setMessage(null);
    try {
      const res = await fetch(`/api/console/sources/${key}/health`, { method: 'POST' });
      const data = (await res.json()) as { error?: string; report?: { status: string; latencyMs: number; detail: string } };
      if (!res.ok) setMessage({ ok: false, text: data.error ?? 'Health check failed to run.' });
      else {
        setMessage({ ok: data.report?.status !== 'down', text: `${key}: ${data.report?.status} in ${data.report?.latencyMs} ms — ${data.report?.detail}` });
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  }

  async function refresh(key: string) {
    setBusy(`refresh:${key}`);
    setMessage(null);
    try {
      const res = await fetch(`/api/console/sources/${key}/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = (await res.json()) as { error?: string; run?: { status: string; discovered: number; updated: number; closed: number; error?: string | null } };
      if (!res.ok) setMessage({ ok: false, text: data.error ?? 'Freshness sweep failed to run.' });
      else {
        setMessage({ ok: data.run?.status === 'ok', text: `${key}: sweep ${data.run?.status} — checked ${data.run?.discovered}, re-seen ${data.run?.updated}, closed ${data.run?.closed}${data.run?.error ? ` (${data.run.error})` : ''}` });
        router.refresh();
      }
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
      {sources.map((s) => (
        <Card key={s.key}>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-ink">{s.name}</h2>
            <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', STATUS_TONE[s.status] ?? STATUS_TONE.disabled)}>{s.status}</span>
            <span className="text-xs text-muted">
              {s.kind} · priority class {s.priority}
            </span>
            <span className={cn('ml-auto text-xs', HEALTH_TONE[s.lastHealthStatus] ?? 'text-muted')}>
              health: {s.lastHealthStatus}
              {s.lastHealthAt ? ` (${new Date(s.lastHealthAt).toLocaleString('en-CA')})` : ''}
            </span>
          </div>
          <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
            <div>
              <dt className="text-muted">Record</dt>
              <dd className={s.recordComplete ? 'text-success' : 'text-warn'}>{s.recordComplete ? 'complete' : 'incomplete — legal basis, terms review, approval and retention are required'}</dd>
            </div>
            <div>
              <dt className="text-muted">Credentials (names only)</dt>
              <dd className={s.missingCredentials.length ? 'text-danger' : 'text-ink'}>
                {s.credentialEnvVars === '[]' ? 'none needed' : s.credentialEnvVars}
                {s.missingCredentials.length ? ` — missing: ${s.missingCredentials.join(', ')}` : ''}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Legal basis</dt>
              <dd className="text-ink">{s.legalBasis || '—'}</dd>
            </div>
            <div>
              <dt className="text-muted">Terms reviewed</dt>
              <dd className="text-ink">{s.termsReviewedAt ? `${new Date(s.termsReviewedAt).toLocaleDateString('en-CA')} by ${s.termsReviewedByEmail}` : '—'}</dd>
            </div>
            <div>
              <dt className="text-muted">Approved</dt>
              <dd className="text-ink">{s.approvedAt ? `${new Date(s.approvedAt).toLocaleDateString('en-CA')} by ${s.approvedByEmail}` : '—'}</dd>
            </div>
            <div>
              <dt className="text-muted">Retention</dt>
              <dd className="text-ink">{s.retentionRef || '—'}</dd>
            </div>
            <div>
              <dt className="text-muted">Last run / success</dt>
              <dd className="text-ink">
                {s.lastRunAt ? new Date(s.lastRunAt).toLocaleString('en-CA') : '—'} / {s.lastSuccessAt ? new Date(s.lastSuccessAt).toLocaleString('en-CA') : '—'}
                {s.errorCount ? ` · ${s.errorCount} consecutive error(s)` : ''}
              </dd>
            </div>
            {s.lastError && (
              <div className="sm:col-span-2">
                <dt className="text-muted">Last error</dt>
                <dd className="text-danger">{s.lastError}</dd>
              </div>
            )}
          </dl>
          {s.notes && <p className="mt-1 text-xs text-muted">{s.notes}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="btn-secondary px-3 py-1.5 text-xs" disabled={busy !== null} aria-label={`Run health check for ${s.name}`} onClick={() => health(s.key)}>
              {busy === `health:${s.key}` && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />} Health check
            </button>
            {/* Stage 06: a freshness sweep on demand (no scheduler exists yet); refused for a source the gate refuses. */}
            <button type="button" className="btn-secondary px-3 py-1.5 text-xs" disabled={busy !== null || s.status === 'disabled'} aria-label={`Run freshness sweep for ${s.name}`} onClick={() => refresh(s.key)}>
              {busy === `refresh:${s.key}` && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />} Freshness sweep
            </button>
            {editing !== s.key && (
              <button type="button" className="btn-secondary px-3 py-1.5 text-xs" aria-label={`Edit record for ${s.name}`} onClick={() => startEdit(s)}>
                Record / enable / disable
              </button>
            )}
          </div>
          {editing === s.key && (
            <form
              className="mt-3 grid gap-3 sm:grid-cols-2"
              onSubmit={(e) => {
                e.preventDefault();
                void submit(s.key);
              }}
            >
              <label className="block text-sm">
                <span className="font-medium text-ink">Action</span>
                <select value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })} className="input mt-1 w-full">
                  <option value="record">Record the review only</option>
                  <option value="enable">Record and enable</option>
                  <option value="disable">Disable</option>
                </select>
              </label>
              <label className="block text-sm">
                <span className="font-medium text-ink">Retention reference</span>
                <input type="text" value={form.retentionRef} onChange={(e) => setForm({ ...form, retentionRef: e.target.value })} className="input mt-1 w-full" maxLength={200} />
              </label>
              <label className="block text-sm sm:col-span-2">
                <span className="font-medium text-ink">Legal basis (API terms, licence, contract, or documented permission)</span>
                <textarea rows={2} value={form.legalBasis} onChange={(e) => setForm({ ...form, legalBasis: e.target.value })} className="input mt-1 w-full" maxLength={2000} />
              </label>
              <label className="block text-sm">
                <span className="font-medium text-ink">robots.txt / ToS position</span>
                <input type="text" value={form.robotsPosition} onChange={(e) => setForm({ ...form, robotsPosition: e.target.value })} className="input mt-1 w-full" maxLength={500} />
              </label>
              <label className="block text-sm">
                <span className="font-medium text-ink">Rate limit per minute (0 = source default)</span>
                <input type="number" min={0} value={form.rateLimitPerMinute} onChange={(e) => setForm({ ...form, rateLimitPerMinute: e.target.value })} className="input mt-1 w-full" />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.attributionRequired} onChange={(e) => setForm({ ...form, attributionRequired: e.target.checked })} />
                Attribution required
              </label>
              <label className="block text-sm">
                <span className="font-medium text-ink">Attribution text</span>
                <input type="text" value={form.attributionText} onChange={(e) => setForm({ ...form, attributionText: e.target.value })} className="input mt-1 w-full" maxLength={500} />
              </label>
              <label className="block text-sm">
                <span className="font-medium text-ink">Current password (re-authentication)</span>
                <input type="password" autoComplete="current-password" required value={form.currentPassword} onChange={(e) => setForm({ ...form, currentPassword: e.target.value })} className="input mt-1 w-full" />
              </label>
              <label className="block text-sm">
                <span className="font-medium text-ink">Reason (the terms review this records)</span>
                <input type="text" required value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} className="input mt-1 w-full" maxLength={500} />
              </label>
              <div className="flex gap-2">
                <button type="submit" className="btn-primary" disabled={busy !== null}>
                  {busy === s.key && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />} Save
                </button>
                <button type="button" className="btn-secondary" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </Card>
      ))}
      <Card>
        <h2 className="text-base font-semibold text-ink">Recent runs</h2>
        {runs.length === 0 ? (
          <p className="mt-1 text-sm text-muted">No runs recorded yet.</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted">
                  <th className="py-1 pr-2">Started</th>
                  <th className="py-1 pr-2">Source</th>
                  <th className="py-1 pr-2">Kind</th>
                  <th className="py-1 pr-2">Status</th>
                  <th className="py-1 pr-2">Found</th>
                  <th className="py-1 pr-2">New</th>
                  <th className="py-1 pr-2">Updated</th>
                  <th className="py-1 pr-2">Closed</th>
                  <th className="py-1 pr-2">Rejected</th>
                  <th className="py-1">Error</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="border-t border-line">
                    <td className="py-1 pr-2 text-ink">{new Date(r.startedAt).toLocaleString('en-CA')}</td>
                    <td className="py-1 pr-2 text-ink">{r.sourceKey}</td>
                    <td className="py-1 pr-2 text-ink">{r.kind}</td>
                    <td className={cn('py-1 pr-2', r.status === 'ok' ? 'text-success' : r.status === 'running' ? 'text-muted' : 'text-danger')}>{r.status}</td>
                    <td className="py-1 pr-2 text-ink">{r.discovered}</td>
                    <td className="py-1 pr-2 text-ink">{r.created}</td>
                    <td className="py-1 pr-2 text-ink">{r.updated}</td>
                    <td className="py-1 pr-2 text-ink">{r.closed}</td>
                    <td className="py-1 pr-2 text-ink">{r.rejected}</td>
                    <td className="py-1 text-danger">{r.error ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
