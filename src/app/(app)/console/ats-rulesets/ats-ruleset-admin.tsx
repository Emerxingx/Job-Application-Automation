'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { Card, cn } from '@/components/ui';

export interface AtsRulesetView {
  id: string;
  platform: string;
  version: number;
  status: string;
  navigationFlowType: string;
  pacing: string;
  selectorMap: string;
  fallbackSelectors: string;
  notes: string;
  createdByEmail: string;
  approvedByEmail: string | null;
  updatedAt: string;
}
export interface AtsAuditView {
  id: string;
  action: string;
  summary: string;
  actorEmail: string;
  reason: string | null;
  createdAt: string;
}

const STATUS_TONE: Record<string, string> = { active: 'bg-success/10 text-success', approved: 'bg-brand-500/10 text-brand-600', draft: 'bg-raised text-muted', retired: 'bg-raised text-muted line-through' };

export function AtsRulesetAdmin({ rulesets, audit }: { rulesets: AtsRulesetView[]; audit: AtsAuditView[] }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState({ platform: 'greenhouse', navigationFlowType: 'single_page', pacing: 'standard', selectorMap: '{\n  "first_name": "",\n  "last_name": "",\n  "email": "",\n  "phone": "",\n  "resume_upload": "",\n  "cover_letter_input": "",\n  "submit_button": "",\n  "next_step_button": ""\n}', fallbackSelectors: '{}', notes: '' });

  const byPlatform = useMemo(() => {
    const map = new Map<string, AtsRulesetView[]>();
    for (const r of rulesets) map.set(r.platform, [...(map.get(r.platform) ?? []), r]);
    return [...map.entries()];
  }, [rulesets]);

  async function send(url: string, method: string, body: Record<string, unknown>, label: string) {
    if (!password) {
      setMessage({ ok: false, text: 'Enter your current password first — every ruleset change is re-authenticated.' });
      return;
    }
    setBusy(label);
    setMessage(null);
    try {
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: password, reason: reason || undefined, ...body }) });
      const data = (await res.json()) as { error?: string; ruleset?: { platform: string; version: number; status: string } };
      if (!res.ok) {
        setMessage({ ok: false, text: data.error ?? 'The change was refused.' });
        if (res.status === 403) setPassword('');
      } else {
        setMessage({ ok: true, text: `${data.ruleset?.platform} v${data.ruleset?.version} is now ${data.ruleset?.status}.` });
        router.refresh();
      }
    } catch {
      setMessage({ ok: false, text: 'The request could not be sent.' });
    } finally {
      setBusy(null);
    }
  }

  function createDraft() {
    let selectorMap: unknown;
    let fallbackSelectors: unknown;
    try {
      selectorMap = JSON.parse(draft.selectorMap);
      fallbackSelectors = draft.fallbackSelectors.trim() ? JSON.parse(draft.fallbackSelectors) : null;
    } catch {
      setMessage({ ok: false, text: 'The selector maps must be valid JSON.' });
      return;
    }
    void send('/api/console/ats-rulesets', 'POST', { platform: draft.platform, navigationFlowType: draft.navigationFlowType, pacing: draft.pacing, selectorMap, fallbackSelectors, notes: draft.notes }, 'create');
  }

  return (
    <div className="space-y-6">
      <Card>
        <h2 className="text-base font-semibold text-ink">Re-authentication</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="font-medium text-ink">Current password</span>
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="input mt-1 w-full" />
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

      {byPlatform.map(([platform, list]) => {
        const current = list.find((r) => r.status === 'active');
        return (
          <Card key={platform}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-base font-semibold text-ink">{platform}</h2>
              <p className="text-sm text-muted">{current ? `Active: v${current.version}` : 'No active ruleset — the engine has nothing to drive this board with.'}</p>
            </div>
            <ul className="mt-3 divide-y divide-line">
              {list.map((r) => {
                const isRollback = r.status === 'approved' && current !== undefined && r.version < current.version;
                return (
                  <li key={r.id} className="py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-ink">v{r.version}</span>
                      <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', STATUS_TONE[r.status] ?? STATUS_TONE.draft)}>{r.status}</span>
                      <span className="text-xs text-muted">
                        {r.navigationFlowType} · pacing {r.pacing}
                      </span>
                      <button type="button" className="ml-auto text-xs text-brand-500 hover:text-brand-600" aria-expanded={open === r.id} aria-controls={`ruleset-${r.id}`} aria-label={`${open === r.id ? 'Hide' : 'Show'} selectors for ${platform} v${r.version}`} onClick={() => setOpen(open === r.id ? null : r.id)}>
                        {open === r.id ? 'Hide selectors' : 'Show selectors'}
                      </button>
                    </div>
                    <p className="mt-1 text-xs text-muted">
                      Created by {r.createdByEmail || 'system'}
                      {r.approvedByEmail ? ` · approved by ${r.approvedByEmail}` : ''}
                    </p>
                    {open === r.id && (
                      <div id={`ruleset-${r.id}`} className="mt-2 text-xs">
                        <pre className="whitespace-pre-wrap rounded-lg bg-raised p-3 text-ink">{r.selectorMap}</pre>
                        {r.fallbackSelectors !== '{}' && <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-raised p-3 text-ink">{r.fallbackSelectors}</pre>}
                        {r.notes && <p className="mt-1 text-muted">{r.notes}</p>}
                      </div>
                    )}
                    <div className="mt-2 flex flex-wrap gap-2">
                      {r.status === 'draft' && (
                        <button type="button" className="btn-secondary px-3 py-1.5 text-xs" disabled={busy !== null} aria-label={`Approve ${platform} v${r.version}`} onClick={() => send(`/api/console/ats-rulesets/${r.id}`, 'PATCH', { action: 'approve' }, r.id)}>
                          Approve
                        </button>
                      )}
                      {r.status === 'approved' && (
                        <button type="button" className="btn-primary px-3 py-1.5 text-xs" disabled={busy !== null} aria-label={`${isRollback ? 'Roll back' : 'Activate'} ${platform} v${r.version}`} onClick={() => send(`/api/console/ats-rulesets/${r.id}`, 'PATCH', { action: 'activate' }, r.id)}>
                          {busy === r.id && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />} {isRollback ? 'Roll back to this version' : 'Activate'}
                        </button>
                      )}
                      {r.status !== 'active' && r.status !== 'retired' && (
                        <button type="button" className="text-xs text-muted hover:text-danger" disabled={busy !== null} aria-label={`Retire ${platform} v${r.version}`} onClick={() => send(`/api/console/ats-rulesets/${r.id}`, 'PATCH', { action: 'retire' }, r.id)}>
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
        <h2 className="text-base font-semibold text-ink">New draft version</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="block text-sm">
            <span className="font-medium text-ink">Platform</span>
            <select value={draft.platform} onChange={(e) => setDraft({ ...draft, platform: e.target.value })} className="input mt-1 w-full">
              {['greenhouse', 'lever', 'workday', 'workable', 'taleo', 'ashby', 'smartrecruiters', 'icims', 'linkedin'].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="font-medium text-ink">Navigation flow</span>
            <select value={draft.navigationFlowType} onChange={(e) => setDraft({ ...draft, navigationFlowType: e.target.value })} className="input mt-1 w-full">
              <option value="single_page">Single page</option>
              <option value="multi_step">Multi-step wizard</option>
              <option value="account_required">Account required</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="font-medium text-ink">Pacing</span>
            <select value={draft.pacing} onChange={(e) => setDraft({ ...draft, pacing: e.target.value })} className="input mt-1 w-full">
              <option value="standard">Standard</option>
              <option value="human_delay">Human delay (declared for assisted apply; enforced from Stage 12)</option>
            </select>
          </label>
          <label className="block text-sm sm:col-span-3">
            <span className="font-medium text-ink">Selector map (JSON; every required key)</span>
            <textarea rows={10} value={draft.selectorMap} onChange={(e) => setDraft({ ...draft, selectorMap: e.target.value })} className="input mt-1 w-full font-mono text-xs" />
          </label>
          <label className="block text-sm sm:col-span-2">
            <span className="font-medium text-ink">Fallback selectors (JSON object of arrays, optional)</span>
            <textarea rows={3} value={draft.fallbackSelectors} onChange={(e) => setDraft({ ...draft, fallbackSelectors: e.target.value })} className="input mt-1 w-full font-mono text-xs" />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-ink">Notes</span>
            <textarea rows={3} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} className="input mt-1 w-full" maxLength={4000} />
          </label>
        </div>
        <button type="button" className="btn-secondary mt-3" disabled={busy !== null} onClick={createDraft}>
          {busy === 'create' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />} Create draft
        </button>
      </Card>

      <Card>
        <h2 className="text-base font-semibold text-ink">Audit trail</h2>
        {audit.length === 0 ? (
          <p className="mt-1 text-sm text-muted">No ruleset changes have been recorded yet.</p>
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
