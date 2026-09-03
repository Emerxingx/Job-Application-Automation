'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { Card, cn } from '@/components/ui';

export interface MappingVersionView {
  id: string;
  version: number;
  status: string;
  mappings: string;
  notes: string;
  createdByEmail: string | null;
  approvedByEmail: string | null;
  updatedAt: string;
}
export interface MappingAuditView {
  id: string;
  action: string;
  summary: string;
  actorEmail: string;
  reason: string | null;
  createdAt: string;
}

const STATUS_TONE: Record<string, string> = { active: 'bg-success/10 text-success', approved: 'bg-brand-500/10 text-brand-600', draft: 'bg-raised text-muted', retired: 'bg-raised text-muted line-through' };

function summarise(json: string): string {
  try {
    const rows = JSON.parse(json) as { canonicalFieldKey: string }[];
    return rows.map((r) => r.canonicalFieldKey).join(', ');
  } catch {
    return '(unreadable)';
  }
}

/**
 * Stage 12 — the field-mapping register's admin. A draft is a JSON array
 * (pre-filled from the active set) validated server-side; every change is
 * re-authenticated and audited; approval needs a second admin.
 */
export function FieldMappingAdmin({ versions, active, builtin, audit }: { versions: MappingVersionView[]; active: { version: string; mappings: string }; builtin: { version: string; mappings: string }; audit: MappingAuditView[] }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [draft, setDraft] = useState<{ mappings: string; notes: string }>({ mappings: active.mappings, notes: '' });

  async function send(url: string, method: string, body: Record<string, unknown>, label: string) {
    if (!password) {
      setMessage({ ok: false, text: 'Enter your current password first — every mapping change is re-authenticated.' });
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
        setMessage({ ok: true, text: `Field mappings v${data.version?.version} are now ${data.version?.status}.` });
        router.refresh();
      }
    } catch {
      setMessage({ ok: false, text: 'The request could not be sent.' });
    } finally {
      setBusy(null);
    }
  }

  function createDraft() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft.mappings);
    } catch {
      setMessage({ ok: false, text: 'The draft is not valid JSON.' });
      return;
    }
    void send('/api/console/field-mappings', 'POST', { mappings: parsed, notes: draft.notes }, 'create');
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
        <h2 className="font-semibold text-ink">In force</h2>
        <p className="mt-1 text-sm text-muted">
          {active.version === builtin.version ? 'No register version is active: applications are prepared with the built-in set and record it as ' : 'Applications are prepared with register version '}
          <code className="rounded bg-surface-2 px-1 text-xs">{active.version}</code>.
        </p>
        <p className="mt-2 text-xs text-faint">{summarise(active.mappings)}</p>
      </Card>

      <Card className="p-5">
        <h2 className="font-semibold text-ink">Re-authenticate</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="label" htmlFor="fm-password">
            Current password
            <input id="fm-password" type="password" autoComplete="current-password" className="input mt-1" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <label className="label" htmlFor="fm-reason">
            Reason (recorded in the audit; required to activate)
            <input id="fm-reason" className="input mt-1" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </label>
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="font-semibold text-ink">New draft</h2>
        <p className="mt-1 text-sm text-muted">A JSON array of mappings — canonicalFieldKey, label, dataType (boolean · numeric · text · select), patterns (contains or regex), selectOptions for a select, and a fallbackRule that tells the applicant what to do when nothing is stored. The server refuses a rule that says to invent, assume or guess.</p>
        <textarea className="input mt-3 h-64 font-mono text-xs" value={draft.mappings} onChange={(e) => setDraft((d) => ({ ...d, mappings: e.target.value }))} aria-label="Mappings JSON" />
        <label className="label mt-3" htmlFor="fm-notes">
          Notes
          <textarea id="fm-notes" className="input mt-1 h-16" value={draft.notes} onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))} maxLength={4000} />
        </label>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="btn-primary" disabled={busy !== null} onClick={createDraft}>
            {busy === 'create' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null} Save as draft
          </button>
          <button type="button" className="btn-ghost" disabled={busy !== null} onClick={() => setDraft((d) => ({ ...d, mappings: builtin.mappings }))}>
            Start from the built-in set
          </button>
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="font-semibold text-ink">Versions</h2>
        {versions.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No register version yet — the built-in set is in force.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {versions.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                <span className="w-12 font-semibold text-ink">v{v.version}</span>
                <span className={cn('chip', STATUS_TONE[v.status] ?? 'bg-raised text-muted')}>{v.status}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-faint" title={summarise(v.mappings)}>
                  {summarise(v.mappings)}
                  {v.notes ? ` — ${v.notes}` : ''}
                </span>
                <span className="text-xs text-faint">
                  by {v.createdByEmail || '—'}
                  {v.approvedByEmail ? `, approved by ${v.approvedByEmail}` : ''}
                </span>
                <span className="flex gap-1">
                  {v.status === 'draft' && (
                    <button type="button" className="btn-secondary px-2 py-1 text-xs" disabled={busy !== null} onClick={() => send(`/api/console/field-mappings/${v.id}`, 'PATCH', { action: 'approve' }, v.id)}>
                      Approve
                    </button>
                  )}
                  {v.status === 'approved' && (
                    <button type="button" className="btn-primary px-2 py-1 text-xs" disabled={busy !== null} onClick={() => send(`/api/console/field-mappings/${v.id}`, 'PATCH', { action: 'activate' }, v.id)}>
                      Activate
                    </button>
                  )}
                  {v.status !== 'active' && v.status !== 'retired' && (
                    <button type="button" className="btn-ghost px-2 py-1 text-xs" disabled={busy !== null} onClick={() => send(`/api/console/field-mappings/${v.id}`, 'PATCH', { action: 'retire' }, v.id)}>
                      Retire
                    </button>
                  )}
                  <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => setDraft({ mappings: v.mappings, notes: '' })}>
                    Load into draft
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-5">
        <h2 className="font-semibold text-ink">Audit</h2>
        {audit.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No changes recorded.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line text-xs">
            {audit.map((a) => (
              <li key={a.id} className="py-2">
                <span className="font-mono text-faint">{a.action}</span> · {a.summary} · {a.actorEmail} · {new Date(a.createdAt).toISOString().slice(0, 16).replace('T', ' ')}
                {a.reason ? <span className="text-muted"> — {a.reason}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
