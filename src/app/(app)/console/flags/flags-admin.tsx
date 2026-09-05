'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, cn } from '@/components/ui';

export interface FlagView {
  key: string;
  description: string;
  readBy: string;
  defaultEnabled: boolean;
  stored: { enabled: boolean; rolloutPercent: number; allowlist: string[]; updatedAt: string } | null;
}

export function FlagsAdmin({ canChange, flags }: { canChange: boolean; flags: FlagView[] }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState('');
  const [edits, setEdits] = useState<Record<string, { enabled: boolean; rolloutPercent: string; allowlist: string }>>(Object.fromEntries(flags.map((f) => [f.key, { enabled: f.stored?.enabled ?? f.defaultEnabled, rolloutPercent: String(f.stored?.rolloutPercent ?? 100), allowlist: (f.stored?.allowlist ?? []).join(', ') }])));
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(key: string) {
    if (!password || !reason) {
      setMessage({ ok: false, text: 'Enter your current password and a reason first.' });
      return;
    }
    const e = edits[key]!;
    setBusy(key);
    setMessage(null);
    try {
      const res = await fetch('/api/console/flags', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: password, reason, key, enabled: e.enabled, rolloutPercent: Number(e.rolloutPercent), allowlist: e.allowlist.split(',').map((s) => s.trim()).filter(Boolean) }) });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ ok: false, text: data.error ?? 'The change was refused.' });
        return;
      }
      setMessage({ ok: true, text: `${key} saved and audited.` });
      router.refresh();
    } catch {
      setMessage({ ok: false, text: 'Could not reach the server.' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {message ? <p className={cn('text-sm', message.ok ? 'text-success' : 'text-danger')}>{message.text}</p> : null}
      {canChange ? (
        <Card className="p-5">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="flex flex-col text-sm">
              <span className="text-muted">Your current password (every change)</span>
              <input type="password" autoComplete="current-password" className="rounded-md border border-line bg-surface px-3 py-2" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <label className="flex flex-col text-sm">
              <span className="text-muted">Reason (audited)</span>
              <input className="rounded-md border border-line bg-surface px-3 py-2" value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
          </div>
        </Card>
      ) : null}
      {flags.map((f) => {
        const e = edits[f.key]!;
        return (
          <Card key={f.key} className="p-5">
            <h2 className="text-base font-semibold text-ink">
              <code>{f.key}</code>
            </h2>
            <p className="text-sm text-muted">{f.description}</p>
            <p className="text-xs text-muted">
              Read by <code>{f.readBy}</code> · default {f.defaultEnabled ? 'on' : 'off'} · {f.stored ? `stored: ${f.stored.enabled ? 'on' : 'off'} at ${f.stored.rolloutPercent}% (${new Date(f.stored.updatedAt).toLocaleString('en-CA')})` : 'no stored value (default applies)'}
            </p>
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={e.enabled} disabled={!canChange} onChange={(ev) => setEdits({ ...edits, [f.key]: { ...e, enabled: ev.target.checked } })} />
                <span>Enabled</span>
              </label>
              <label className="flex flex-col text-sm">
                <span className="text-muted">Rollout %</span>
                <input type="number" min={0} max={100} className="w-24 rounded-md border border-line bg-surface px-3 py-2" disabled={!canChange} value={e.rolloutPercent} onChange={(ev) => setEdits({ ...edits, [f.key]: { ...e, rolloutPercent: ev.target.value } })} />
              </label>
              <label className="flex flex-1 flex-col text-sm">
                <span className="text-muted">Allow-list (account ids, comma-separated)</span>
                <input className="rounded-md border border-line bg-surface px-3 py-2" disabled={!canChange} value={e.allowlist} onChange={(ev) => setEdits({ ...edits, [f.key]: { ...e, allowlist: ev.target.value } })} />
              </label>
              {canChange ? (
                <button type="button" className="btn-primary text-sm" disabled={busy !== null} onClick={() => save(f.key)}>
                  Save
                </button>
              ) : null}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
