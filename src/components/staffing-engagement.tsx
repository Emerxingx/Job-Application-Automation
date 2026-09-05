'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Card, StatusBadge } from '@/components/ui';

export interface EngagementView {
  id: string;
  status: string;
  jurisdiction: string;
  contract: { clientName: string; status: string; agencyLicenceRef: string };
  fee: { name: string; guaranteeDays: number } | null;
  verdict: 'allowed' | 'blocked' | 'unconfirmed';
  checks: { rule: string; status: string; reason: string }[];
  representations: { id: string; status: string; email: string; name: string | null }[];
  placements: { id: string; status: string; startDate: string; feeCents: number | null; currency: string; guaranteeEndsAt: string; invoices: { id: string; number: string | null; status: string; creditedCents: number }[] }[];
  canWrite: boolean;
  canRequest: boolean;
  canInvoice: boolean;
}

/** Stage 19 (ADR-0034): one engagement - its jurisdiction evaluation, representation requests, placements and their invoices. */
export function StaffingEngagement({ organizationId, view }: { organizationId: string; view: EngagementView }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [placement, setPlacement] = useState({ representationConsentId: '', startDate: '', salary: '' });

  async function call(key: string, url: string, method: string, body: unknown, after?: () => void) {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'The request failed.');
        return;
      }
      after?.();
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(null);
    }
  }
  const granted = view.representations.filter((r) => r.status === 'granted');
  const TONE: Record<string, string> = { allowed: 'text-success', blocked: 'text-danger', unconfirmed: 'text-warning' };

  return (
    <div className="space-y-4">
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-ink">
              {view.contract.clientName} · {view.jurisdiction}
            </h2>
            <p className="text-xs text-muted">{view.fee ? `${view.fee.name} · ${view.fee.guaranteeDays}-day guarantee` : 'Fee structure not visible to your role'} · contract {view.contract.status}</p>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge status={view.status} />
            {view.canWrite && view.status === 'draft' ? (
              <button type="button" className="btn-secondary text-xs" disabled={busy !== null} onClick={() => call('activate', `/api/staffing/engagements/${view.id}`, 'PATCH', { organizationId, status: 'active' })}>
                Activate
              </button>
            ) : null}
            {view.canWrite && view.status === 'active' ? (
              <button type="button" className="rounded-md border border-line px-3 py-2 text-xs text-muted" disabled={busy !== null} onClick={() => call('close', `/api/staffing/engagements/${view.id}`, 'PATCH', { organizationId, status: 'closed' })}>
                Close
              </button>
            ) : null}
          </div>
        </div>
        <p className={`mt-3 text-sm font-medium ${TONE[view.verdict]}`}>
          Jurisdiction: {view.verdict === 'allowed' ? 'rules recorded; every check passes' : view.verdict === 'blocked' ? 'blocked' : 'unconfirmed - counsel has not recorded the rules for this jurisdiction (L-4); placements can be recorded but no invoice is issued'}
        </p>
        <ul className="mt-1 space-y-0.5 text-xs text-muted">
          {view.checks.map((c) => (
            <li key={c.rule}>
              {c.rule.replace('_', ' ')}: {c.status} - {c.reason}
            </li>
          ))}
        </ul>
      </Card>

      <Card className="p-5">
        <h2 className="text-base font-semibold text-ink">Representation</h2>
        <p className="text-xs text-muted">Ask a person, by the email they gave you, to be represented for this engagement. The platform does not say whether an account exists; the person answers under their Settings. A name appears only once they consent.</p>
        <ul className="mt-2 divide-y divide-line text-sm">
          {view.representations.length === 0 ? <li className="py-2 text-muted">Nobody asked yet.</li> : null}
          {view.representations.map((r) => (
            <li key={r.id} className="flex items-center justify-between py-2">
              <span className="text-ink">{r.name ?? r.email}</span>
              <StatusBadge status={r.status} />
            </li>
          ))}
        </ul>
        {view.canRequest && (view.status === 'active' || view.status === 'draft') ? (
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              call('ask', `/api/staffing/engagements/${view.id}/representations`, 'POST', { organizationId, email }, () => setEmail(''));
            }}
          >
            <input type="email" className="flex-1 rounded-md border border-line bg-surface px-3 py-2 text-sm" placeholder="Candidate email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            <button type="submit" className="btn-secondary text-xs" disabled={busy !== null}>
              {busy === 'ask' ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              Ask for representation
            </button>
          </form>
        ) : null}
      </Card>

      <Card className="p-5">
        <h2 className="text-base font-semibold text-ink">Placements</h2>
        <ul className="mt-2 divide-y divide-line text-sm">
          {view.placements.length === 0 ? <li className="py-2 text-muted">None yet.</li> : null}
          {view.placements.map((p) => (
            <li key={p.id} className="py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-ink">
                  Starts {new Date(p.startDate).toLocaleDateString('en-CA')} · guarantee to {new Date(p.guaranteeEndsAt).toLocaleDateString('en-CA')}
                  {p.feeCents !== null ? ` · fee ${(p.feeCents / 100).toLocaleString('en-CA', { minimumFractionDigits: 2 })} ${p.currency}` : ''}
                </span>
                <span className="flex items-center gap-2">
                  <StatusBadge status={p.status} />
                  {view.canWrite && p.status === 'pending' ? (
                    <>
                      <button type="button" className="btn-secondary text-xs" disabled={busy !== null} onClick={() => call(p.id, `/api/staffing/placements/${p.id}`, 'PATCH', { organizationId, status: 'started' })}>
                        Started
                      </button>
                      <button type="button" className="rounded-md border border-line px-3 py-2 text-xs text-muted" disabled={busy !== null} onClick={() => call(`cx-${p.id}`, `/api/staffing/placements/${p.id}`, 'PATCH', { organizationId, status: 'cancelled' })}>
                        Never started
                      </button>
                    </>
                  ) : null}
                  {view.canWrite && p.status === 'started' ? (
                    <>
                      <button type="button" className="btn-secondary text-xs" disabled={busy !== null} onClick={() => call(p.id, `/api/staffing/placements/${p.id}`, 'PATCH', { organizationId, status: 'completed' })}>
                        Completed
                      </button>
                      <button type="button" className="rounded-md border border-line px-3 py-2 text-xs text-danger" disabled={busy !== null} onClick={() => call(`fo-${p.id}`, `/api/staffing/placements/${p.id}`, 'PATCH', { organizationId, status: 'fell_off', fellOffReason: 'other' })}>
                        Fell off
                      </button>
                    </>
                  ) : null}
                  {view.canInvoice && (p.status === 'started' || p.status === 'completed') && p.invoices.every((i) => i.status === 'void') ? (
                    <button type="button" className="btn-primary text-xs" disabled={busy !== null} onClick={() => call(`inv-${p.id}`, `/api/staffing/placements/${p.id}/invoices`, 'POST', { organizationId })}>
                      Issue invoice
                    </button>
                  ) : null}
                  {view.canInvoice && p.status === 'fell_off' && p.invoices.some((i) => (i.status === 'issued' || i.status === 'paid') && !i.creditedCents) ? (
                    <button type="button" className="btn-secondary text-xs" disabled={busy !== null} onClick={() => call(`cr-${p.id}`, `/api/staffing/invoices/${p.invoices.find((i) => i.status === 'issued' || i.status === 'paid')!.id}`, 'PATCH', { organizationId, action: 'credit_guarantee' })}>
                      Guarantee credit
                    </button>
                  ) : null}
                </span>
              </div>
              {p.invoices.length ? <p className="mt-1 text-xs text-muted">{p.invoices.map((i) => `${i.number ?? 'draft'} (${i.status}${i.creditedCents ? ', credited' : ''})`).join(', ')}</p> : null}
            </li>
          ))}
        </ul>
        {view.canWrite && view.status === 'active' && granted.length > 0 ? (
          <form
            className="mt-3 grid gap-2 md:grid-cols-4"
            onSubmit={(e) => {
              e.preventDefault();
              call('place', `/api/staffing/engagements/${view.id}/placements`, 'POST', { organizationId, representationConsentId: placement.representationConsentId, startDate: new Date(placement.startDate).toISOString(), salaryCents: Math.round(Number(placement.salary) * 100) }, () => setPlacement({ representationConsentId: '', startDate: '', salary: '' }));
            }}
          >
            <select className="rounded-md border border-line bg-surface px-3 py-2 text-sm" required value={placement.representationConsentId} onChange={(e) => setPlacement({ ...placement, representationConsentId: e.target.value })}>
              <option value="">Represented candidate</option>
              {granted.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name ?? r.email}
                </option>
              ))}
            </select>
            <input type="date" className="rounded-md border border-line bg-surface px-3 py-2 text-sm" required value={placement.startDate} onChange={(e) => setPlacement({ ...placement, startDate: e.target.value })} />
            <input type="number" min={1} className="rounded-md border border-line bg-surface px-3 py-2 text-sm" placeholder="Annual salary" required value={placement.salary} onChange={(e) => setPlacement({ ...placement, salary: e.target.value })} />
            <button type="submit" className="btn-secondary text-xs" disabled={busy !== null}>
              Record placement
            </button>
          </form>
        ) : null}
      </Card>
    </div>
  );
}
