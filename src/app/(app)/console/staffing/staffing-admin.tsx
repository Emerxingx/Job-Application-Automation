'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Card, cn } from '@/components/ui';

export interface JurisdictionView {
  jurisdiction: string;
  name: string;
  status: string;
  licenceRequired: boolean | null;
  candidateFeesProhibited: boolean | null;
  maxGuaranteeDays: number | null;
  reference: string;
  notes: string;
  recordedByEmail: string;
  recordedAt: string | null;
}

const TONE: Record<string, string> = { recorded: 'bg-success/10 text-success', prohibited: 'bg-danger/10 text-danger', unrecorded: 'bg-warning/10 text-warning' };
const tri = (v: boolean | null) => (v === null ? 'not recorded' : v ? 'yes' : 'no');

/**
 * Stage 19 (ADR-0034): counsel's answer per jurisdiction (L-4), recorded by
 * an admin with a citation and a reason. Nothing here states what any
 * jurisdiction requires; an unrecorded row answers "unknown" everywhere and
 * blocks invoicing.
 */
export function StaffingAdmin({ jurisdictions }: { jurisdictions: JurisdictionView[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ status: 'recorded', licenceRequired: '', candidateFeesProhibited: '', maxGuaranteeDays: '', reference: '', notes: '', reason: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  function open(j: JurisdictionView) {
    setEditing(j.jurisdiction);
    setForm({ status: j.status === 'unrecorded' ? 'recorded' : j.status, licenceRequired: j.licenceRequired === null ? '' : String(j.licenceRequired), candidateFeesProhibited: j.candidateFeesProhibited === null ? '' : String(j.candidateFeesProhibited), maxGuaranteeDays: j.maxGuaranteeDays === null ? '' : String(j.maxGuaranteeDays), reference: j.reference, notes: j.notes, reason: '' });
    setMessage(null);
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setBusy(true);
    setMessage(null);
    try {
      const tri = (v: string) => (v === '' ? null : v === 'true');
      const res = await fetch('/api/console/staffing/jurisdictions', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jurisdiction: editing, status: form.status, licenceRequired: tri(form.licenceRequired), candidateFeesProhibited: tri(form.candidateFeesProhibited), maxGuaranteeDays: form.maxGuaranteeDays === '' ? null : Number(form.maxGuaranteeDays), reference: form.reference, notes: form.notes, reason: form.reason }) });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ ok: false, text: data.error ?? 'Could not record the rule.' });
        return;
      }
      setMessage({ ok: true, text: `${editing} recorded.` });
      setEditing(null);
      router.refresh();
    } catch {
      setMessage({ ok: false, text: 'Could not reach the server.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">Every targeted jurisdiction has a row. Nothing about a jurisdiction is asserted by the code: an unrecorded row answers &ldquo;unknown&rdquo; to every check, a placement under it is marked unconfirmed, and no invoice is issued under it. Record counsel&rsquo;s answer with the citation they relied on (COMPLIANCE_REGISTER.md L-4).</p>
      {message ? <p className={cn('text-sm', message.ok ? 'text-success' : 'text-danger')}>{message.text}</p> : null}
      <Card className="p-0">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3">Jurisdiction</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Licence required</th>
              <th className="px-4 py-3">Candidate fees prohibited</th>
              <th className="px-4 py-3">Max guarantee</th>
              <th className="px-4 py-3">Recorded</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {jurisdictions.map((j) => (
              <tr key={j.jurisdiction} className="border-t border-line">
                <td className="px-4 py-2">
                  <span className="font-medium text-ink">{j.jurisdiction}</span> <span className="text-muted">{j.name}</span>
                </td>
                <td className="px-4 py-2">
                  <span className={cn('rounded-full px-2 py-0.5 text-xs', TONE[j.status] ?? TONE.unrecorded)}>{j.status}</span>
                </td>
                <td className="px-4 py-2 text-muted">{tri(j.licenceRequired)}</td>
                <td className="px-4 py-2 text-muted">{tri(j.candidateFeesProhibited)}</td>
                <td className="px-4 py-2 text-muted">{j.maxGuaranteeDays === null ? 'not recorded' : `${j.maxGuaranteeDays} days`}</td>
                <td className="px-4 py-2 text-xs text-muted">{j.recordedAt ? `${j.recordedByEmail} · ${new Date(j.recordedAt).toLocaleDateString('en-CA')}` : '—'}</td>
                <td className="px-4 py-2 text-right">
                  <button type="button" className="btn-secondary text-xs" onClick={() => open(j)}>
                    Record
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {editing ? (
        <Card className="p-5">
          <h2 className="text-base font-semibold text-ink">Record {editing}</h2>
          <form onSubmit={save} className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="flex flex-col text-sm">
              <span className="text-muted">Status</span>
              <select className="rounded-md border border-line bg-surface px-3 py-2" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                <option value="recorded">recorded</option>
                <option value="prohibited">prohibited (do not place here)</option>
                <option value="unrecorded">unrecorded (withdraw the answer)</option>
              </select>
            </label>
            <label className="flex flex-col text-sm">
              <span className="text-muted">Agency licence required</span>
              <select className="rounded-md border border-line bg-surface px-3 py-2" value={form.licenceRequired} onChange={(e) => setForm({ ...form, licenceRequired: e.target.value })}>
                <option value="">not recorded</option>
                <option value="true">yes</option>
                <option value="false">no</option>
              </select>
            </label>
            <label className="flex flex-col text-sm">
              <span className="text-muted">Fees to a candidate prohibited</span>
              <select className="rounded-md border border-line bg-surface px-3 py-2" value={form.candidateFeesProhibited} onChange={(e) => setForm({ ...form, candidateFeesProhibited: e.target.value })}>
                <option value="">not recorded</option>
                <option value="true">yes</option>
                <option value="false">no</option>
              </select>
            </label>
            <label className="flex flex-col text-sm">
              <span className="text-muted">Longest guarantee period allowed (days; blank = no limit recorded)</span>
              <input type="number" min={1} max={3650} className="rounded-md border border-line bg-surface px-3 py-2" value={form.maxGuaranteeDays} onChange={(e) => setForm({ ...form, maxGuaranteeDays: e.target.value })} />
            </label>
            <label className="flex flex-col text-sm md:col-span-2">
              <span className="text-muted">Citation (the statute or regulation counsel relied on)</span>
              <input className="rounded-md border border-line bg-surface px-3 py-2" value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
            </label>
            <label className="flex flex-col text-sm md:col-span-2">
              <span className="text-muted">Notes</span>
              <textarea className="rounded-md border border-line bg-surface px-3 py-2" rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </label>
            <label className="flex flex-col text-sm md:col-span-2">
              <span className="text-muted">Reason (audited)</span>
              <input className="rounded-md border border-line bg-surface px-3 py-2" required minLength={3} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
            </label>
            <div className="flex gap-2 md:col-span-2">
              <button type="submit" className="btn-primary" disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Record
              </button>
              <button type="button" className="btn-secondary" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
