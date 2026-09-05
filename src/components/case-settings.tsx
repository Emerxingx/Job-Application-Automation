'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui';

/** Stage 17: the organisation admin's controls - service roles and the retention policy. No policy means no automatic purge. */
export function CaseSettings({ organizationId, members, policy }: { organizationId: string; members: { userId: string; label: string; serviceRole: string | null; ladder: string }[]; policy: { caseNoteDays: number; closedCaseDays: number; note: string } | null }) {
  const router = useRouter();
  const [noteDays, setNoteDays] = useState(String(policy?.caseNoteDays ?? 730));
  const [caseDays, setCaseDays] = useState(String(policy?.closedCaseDays ?? 2555));
  const [note, setNote] = useState(policy?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function send(url: string, method: string, body: unknown, okText: string) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      setMessage(res.ok ? { ok: true, text: okText } : { ok: false, text: data.error ?? 'Request failed.' });
      if (res.ok) router.refresh();
    } catch {
      setMessage({ ok: false, text: 'Could not reach the server.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold text-ink">Organisation settings</h2>
      <h3 className="mt-3 text-sm font-medium text-muted">Service roles</h3>
      <ul className="mt-1 space-y-1 text-sm">
        {members.map((m) => (
          <li key={m.userId} className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {m.label} <span className="text-xs text-muted">({m.ladder})</span>
            </span>
            {m.ladder === 'owner' || m.ladder === 'admin' ? (
              <span className="text-xs text-muted">admin</span>
            ) : (
              <select className="rounded border border-line bg-surface px-2 py-1 text-xs" value={m.serviceRole ?? ''} disabled={busy} onChange={(e) => send('/api/cases/roster', 'PATCH', { organizationId, memberUserId: m.userId, serviceRole: e.target.value || null }, 'Role set and recorded.')}>
                <option value="">viewer (default)</option>
                <option value="case_manager">case manager</option>
                <option value="supervisor">supervisor</option>
              </select>
            )}
          </li>
        ))}
      </ul>
      <h3 className="mt-4 text-sm font-medium text-muted">Retention policy</h3>
      <p className="text-xs text-muted">{policy ? 'Applied when the retention job runs.' : 'No policy is set: nothing is purged automatically. Set one only with your programme’s retention rules in hand.'}</p>
      <form
        className="mt-2 flex flex-wrap items-end gap-2 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          send('/api/cases/retention', 'PUT', { organizationId, caseNoteDays: Number(noteDays), closedCaseDays: Number(caseDays), note }, 'Retention policy set and recorded.');
        }}
      >
        <label className="flex flex-col">
          <span className="text-xs text-muted">Notes and assessments kept (days)</span>
          <input className="w-32 rounded-md border border-line bg-surface px-3 py-2" inputMode="numeric" value={noteDays} onChange={(e) => setNoteDays(e.target.value)} />
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-muted">Closed cases kept (days)</span>
          <input className="w-32 rounded-md border border-line bg-surface px-3 py-2" inputMode="numeric" value={caseDays} onChange={(e) => setCaseDays(e.target.value)} />
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-muted">Reference (the rule this follows)</span>
          <input className="rounded-md border border-line bg-surface px-3 py-2" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        </label>
        <button type="submit" className="btn-secondary" disabled={busy}>
          Save policy
        </button>
      </form>
      {message ? (
        <p role={message.ok ? 'status' : 'alert'} className={`mt-2 text-sm ${message.ok ? 'text-success' : 'text-danger'}`}>
          {message.text}
        </p>
      ) : null}
    </Card>
  );
}
