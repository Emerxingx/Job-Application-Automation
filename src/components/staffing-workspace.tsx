'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Card, StatusBadge } from '@/components/ui';

export interface ContractRow {
  id: string;
  clientName: string;
  jurisdiction: string;
  status: string;
  agencyLicenceRef: string;
  engagements: number;
}
export interface FeeRow {
  id: string;
  name: string;
  kind: string;
  percentBps: number | null;
  flatCents: number | null;
  currency: string;
  guaranteeDays: number;
}
export interface EngagementRow {
  id: string;
  title: string;
  status: string;
  jurisdiction: string;
  clientName: string;
  representations: number;
  placements: number;
}
export interface InvoiceRow {
  id: string;
  number: string | null;
  status: string;
  amountCents: number;
  creditedCents: number;
  currency: string;
  clientName: string;
}

/**
 * Stage 19 (ADR-0034): an agency's contracts, fee structures (the client
 * pays - there is no other payer), engagements and placement invoices, as
 * the role may see them. No candidate is named here.
 */
export function StaffingWorkspace({ organizationId, role, contracts, fees, engagements, invoices }: { organizationId: string; role: string; contracts: ContractRow[]; fees: FeeRow[] | null; engagements: EngagementRow[]; invoices: InvoiceRow[] | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [client, setClient] = useState({ clientName: '', jurisdiction: 'CA-BC', agencyLicenceRef: '' });
  const [fee, setFee] = useState({ name: '', kind: 'contingency', percent: '20', flat: '', guaranteeDays: '90' });
  const [eng, setEng] = useState({ contractId: '', feeStructureId: '', title: '' });
  const admin = role === 'admin';

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
  const money = (c: number, cur: string) => `${(c / 100).toLocaleString('en-CA', { minimumFractionDigits: 2 })} ${cur}`;

  return (
    <div className="space-y-6">
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="text-base font-semibold text-ink">Client contracts</h2>
          <ul className="mt-2 divide-y divide-line text-sm">
            {contracts.length === 0 ? <li className="py-2 text-muted">None yet.</li> : null}
            {contracts.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-2 py-2">
                <span>
                  <span className="font-medium text-ink">{c.clientName}</span> <span className="text-xs text-muted">· {c.jurisdiction}{c.agencyLicenceRef ? ` · licence ${c.agencyLicenceRef}` : ''} · {c.engagements} engagement{c.engagements === 1 ? '' : 's'}</span>
                </span>
                <span className="flex items-center gap-2">
                  <StatusBadge status={c.status} />
                  {admin && c.status === 'draft' ? (
                    <button type="button" className="btn-secondary text-xs" disabled={busy !== null} onClick={() => call(c.id, `/api/staffing/contracts/${c.id}`, 'PATCH', { organizationId, status: 'active' })}>
                      Activate
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
          {admin ? (
            <form
              className="mt-3 grid gap-2 md:grid-cols-3"
              onSubmit={(e) => {
                e.preventDefault();
                call('contract', '/api/staffing/contracts', 'POST', { organizationId, ...client, agencyLicenceRef: client.agencyLicenceRef || undefined }, () => setClient({ clientName: '', jurisdiction: 'CA-BC', agencyLicenceRef: '' }));
              }}
            >
              <input className="rounded-md border border-line bg-surface px-3 py-2 text-sm" placeholder="Client name" required minLength={2} value={client.clientName} onChange={(e) => setClient({ ...client, clientName: e.target.value })} />
              <input className="rounded-md border border-line bg-surface px-3 py-2 text-sm" placeholder="Jurisdiction (CA-BC)" required pattern="[A-Z]{2}(-[A-Z0-9]{2,3})?" value={client.jurisdiction} onChange={(e) => setClient({ ...client, jurisdiction: e.target.value.toUpperCase() })} />
              <input className="rounded-md border border-line bg-surface px-3 py-2 text-sm" placeholder="Agency licence ref (as stated)" value={client.agencyLicenceRef} onChange={(e) => setClient({ ...client, agencyLicenceRef: e.target.value })} />
              <div className="md:col-span-3">
                <button type="submit" className="btn-secondary text-xs" disabled={busy !== null}>
                  {busy === 'contract' ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                  Add contract (draft)
                </button>
              </div>
            </form>
          ) : null}
        </Card>

        {fees ? (
          <Card className="p-5">
            <h2 className="text-base font-semibold text-ink">Fee structures</h2>
            <p className="text-xs text-muted">What the client pays. No structure can describe a charge to a candidate.</p>
            <ul className="mt-2 divide-y divide-line text-sm">
              {fees.length === 0 ? <li className="py-2 text-muted">None yet.</li> : null}
              {fees.map((f) => (
                <li key={f.id} className="py-2">
                  <span className="font-medium text-ink">{f.name}</span> <span className="text-xs text-muted">· {f.kind === 'flat' ? money(f.flatCents ?? 0, f.currency) : `${(f.percentBps ?? 0) / 100}%`} · {f.guaranteeDays}-day guarantee · paid by the client</span>
                </li>
              ))}
            </ul>
            {admin ? (
              <form
                className="mt-3 grid gap-2 md:grid-cols-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  call('fee', '/api/staffing/fees', 'POST', { organizationId, name: fee.name, kind: fee.kind, percentBps: fee.kind === 'flat' ? null : Math.round(Number(fee.percent) * 100), flatCents: fee.kind === 'flat' ? Math.round(Number(fee.flat) * 100) : null, guaranteeDays: Number(fee.guaranteeDays) }, () => setFee({ name: '', kind: 'contingency', percent: '20', flat: '', guaranteeDays: '90' }));
                }}
              >
                <input className="rounded-md border border-line bg-surface px-3 py-2 text-sm" placeholder="Name" required minLength={2} value={fee.name} onChange={(e) => setFee({ ...fee, name: e.target.value })} />
                <select className="rounded-md border border-line bg-surface px-3 py-2 text-sm" value={fee.kind} onChange={(e) => setFee({ ...fee, kind: e.target.value })}>
                  <option value="contingency">contingency (%)</option>
                  <option value="retained">retained (%)</option>
                  <option value="flat">flat</option>
                </select>
                {fee.kind === 'flat' ? (
                  <input type="number" min={1} className="rounded-md border border-line bg-surface px-3 py-2 text-sm" placeholder="Amount" value={fee.flat} onChange={(e) => setFee({ ...fee, flat: e.target.value })} />
                ) : (
                  <input type="number" min={0.01} max={100} step={0.01} className="rounded-md border border-line bg-surface px-3 py-2 text-sm" placeholder="Percent" value={fee.percent} onChange={(e) => setFee({ ...fee, percent: e.target.value })} />
                )}
                <input type="number" min={0} max={3650} className="rounded-md border border-line bg-surface px-3 py-2 text-sm" placeholder="Guarantee days" value={fee.guaranteeDays} onChange={(e) => setFee({ ...fee, guaranteeDays: e.target.value })} />
                <div className="md:col-span-2">
                  <button type="submit" className="btn-secondary text-xs" disabled={busy !== null}>
                    Add fee structure
                  </button>
                </div>
              </form>
            ) : null}
          </Card>
        ) : null}
      </div>

      <Card className="p-5">
        <h2 className="text-base font-semibold text-ink">Engagements</h2>
        <table className="mt-2 w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="py-2">Engagement</th>
              <th className="py-2">Client</th>
              <th className="py-2">Status</th>
              <th className="py-2">Represented</th>
              <th className="py-2">Placed</th>
            </tr>
          </thead>
          <tbody>
            {engagements.length === 0 ? (
              <tr>
                <td className="py-3 text-muted" colSpan={5}>
                  None yet.
                </td>
              </tr>
            ) : null}
            {engagements.map((e) => (
              <tr key={e.id} className="border-t border-line">
                <td className="py-2">
                  <Link href={`/dashboard/staffing/${e.id}?org=${organizationId}`} className="font-medium text-ink hover:underline">
                    {e.title}
                  </Link>
                </td>
                <td className="py-2 text-muted">
                  {e.clientName} · {e.jurisdiction}
                </td>
                <td className="py-2">
                  <StatusBadge status={e.status} />
                </td>
                <td className="py-2 text-muted">{e.representations}</td>
                <td className="py-2 text-muted">{e.placements}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {role !== 'finance' && role !== 'viewer' && contracts.length > 0 ? (
          <form
            className="mt-3 grid gap-2 md:grid-cols-4"
            onSubmit={(e) => {
              e.preventDefault();
              call('eng', '/api/staffing/engagements', 'POST', { organizationId, ...eng }, () => setEng({ contractId: '', feeStructureId: '', title: '' }));
            }}
          >
            <input className="rounded-md border border-line bg-surface px-3 py-2 text-sm" placeholder="Title" required minLength={2} value={eng.title} onChange={(e) => setEng({ ...eng, title: e.target.value })} />
            <select className="rounded-md border border-line bg-surface px-3 py-2 text-sm" required value={eng.contractId} onChange={(e) => setEng({ ...eng, contractId: e.target.value })}>
              <option value="">Contract</option>
              {contracts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.clientName} ({c.jurisdiction})
                </option>
              ))}
            </select>
            <select className="rounded-md border border-line bg-surface px-3 py-2 text-sm" required value={eng.feeStructureId} onChange={(e) => setEng({ ...eng, feeStructureId: e.target.value })}>
              <option value="">Fee structure</option>
              {(fees ?? []).map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
            <button type="submit" className="btn-secondary text-xs" disabled={busy !== null}>
              Open engagement (draft)
            </button>
          </form>
        ) : null}
      </Card>

      {invoices ? (
        <Card className="p-5">
          <h2 className="text-base font-semibold text-ink">Placement invoices</h2>
          <p className="text-xs text-muted">Raised to the client, in the PL book. The candidate is never a party.</p>
          <ul className="mt-2 divide-y divide-line text-sm">
            {invoices.length === 0 ? <li className="py-2 text-muted">None yet.</li> : null}
            {invoices.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <span className="font-medium text-ink">{i.number ?? 'draft'}</span> <span className="text-xs text-muted">· {i.clientName} · {money(i.amountCents, i.currency)}{i.creditedCents ? ` · credited ${money(i.creditedCents, i.currency)}` : ''}</span>
                </span>
                <span className="flex items-center gap-2">
                  <StatusBadge status={i.status} />
                  {i.status === 'issued' ? (
                    <>
                      <button type="button" className="btn-secondary text-xs" disabled={busy !== null} onClick={() => call(i.id, `/api/staffing/invoices/${i.id}`, 'PATCH', { organizationId, action: 'paid' })}>
                        Mark paid
                      </button>
                      {!i.creditedCents ? (
                        <button type="button" className="rounded-md border border-line px-3 py-2 text-xs text-danger" disabled={busy !== null} onClick={() => call(`void-${i.id}`, `/api/staffing/invoices/${i.id}`, 'PATCH', { organizationId, action: 'void', reason: 'other' })}>
                          Void
                        </button>
                      ) : null}
                    </>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
