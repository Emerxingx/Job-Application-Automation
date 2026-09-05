'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { Card, cn } from '@/components/ui';

export interface EntitlementRowView {
  id: string;
  capability: string;
  kind: string;
  quantity: number | null;
  source: string;
  sourceRef: string | null;
  grantedAt: string;
  grantedBy: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  note: string;
}
export interface EntitlementAuditView {
  id: string;
  action: string;
  summary: string;
  actorEmail: string;
  reason: string | null;
  createdAt: string;
  entityId: string;
}

const SOURCES = ['comp', 'pilot', 'licence', 'bonus', 'staff', 'cap'] as const;

/** Stage 15 - look an account up, see the answer and every row behind it, grant or revoke with a reason under step-up. */
export function EntitlementAdmin({ canChange, lookupEmail, user, rows, resolved, capabilities, audit }: { canChange: boolean; lookupEmail: string; user: { id: string; email: string; fullName: string; plan: string | null; paymentStatus: string | null } | null; rows: EntitlementRowView[]; resolved: { capability: string; value: number | boolean; source: string }[]; capabilities: { key: string; kind: string; description: string }[]; audit: EntitlementAuditView[] }) {
  const router = useRouter();
  const [email, setEmail] = useState(lookupEmail);
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState('');
  const [capability, setCapability] = useState(capabilities[0]?.key ?? '');
  const [quantity, setQuantity] = useState('');
  const [source, setSource] = useState<(typeof SOURCES)[number]>('comp');
  const [expiresAt, setExpiresAt] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const kind = capabilities.find((c) => c.key === capability)?.kind ?? 'boolean';

  async function send(method: 'POST' | 'DELETE', body: Record<string, unknown>, label: string) {
    if (!password) {
      setMessage({ ok: false, text: 'Enter your current password first - every entitlement change is re-authenticated.' });
      return;
    }
    if (!reason.trim()) {
      setMessage({ ok: false, text: 'Say why. The reason goes into the audit row.' });
      return;
    }
    setBusy(label);
    setMessage(null);
    try {
      const res = await fetch('/api/console/entitlements', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: password, reason, ...body }) });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setMessage({ ok: false, text: data.error ?? 'That did not work.' });
        return;
      }
      setMessage({ ok: true, text: label === 'grant' ? 'Granted and audited.' : 'Revoked and audited.' });
      setReason('');
      router.refresh();
    } catch {
      setMessage({ ok: false, text: 'Network error.' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            router.push(`/console/entitlements?email=${encodeURIComponent(email.trim())}`);
          }}
        >
          <label className="flex flex-col text-sm">
            <span className="text-muted">Account email</span>
            <input className="rounded-md border border-line bg-surface px-3 py-2" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="person@example.com" />
          </label>
          <button type="submit" className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white">
            Look up
          </button>
        </form>
      </Card>

      {user ? (
        <>
          <Card>
            <h2 className="text-lg font-semibold">
              {user.fullName} <span className="text-muted">· {user.email}</span>
            </h2>
            <p className="text-sm text-muted">
              Payment state: {user.plan ?? 'no plan'} {user.paymentStatus ? `(${user.paymentStatus})` : ''} - shown for context; access below is decided by the rows, never by this.
            </p>
            <h3 className="mt-4 font-medium">What this account may do right now</h3>
            <table className="mt-2 w-full text-sm">
              <thead>
                <tr className="text-left text-muted">
                  <th className="py-1">Capability</th>
                  <th className="py-1">Value</th>
                  <th className="py-1">From</th>
                </tr>
              </thead>
              <tbody>
                {resolved.map((r) => (
                  <tr key={r.capability} className="border-t border-line">
                    <td className="py-1 font-mono text-xs">{r.capability}</td>
                    <td className="py-1">{typeof r.value === 'boolean' ? (r.value ? 'yes' : 'no') : r.value >= 1_000_000 ? 'unlimited' : r.value}</td>
                    <td className="py-1 text-muted">{r.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card>
            <h3 className="font-medium">Rows ({rows.length})</h3>
            <table className="mt-2 w-full text-sm">
              <thead>
                <tr className="text-left text-muted">
                  <th className="py-1">Capability</th>
                  <th className="py-1">Quantity</th>
                  <th className="py-1">Source</th>
                  <th className="py-1">Granted</th>
                  <th className="py-1">Expires</th>
                  <th className="py-1">State</th>
                  <th className="py-1" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={cn('border-t border-line', r.revokedAt && 'text-muted')}>
                    <td className="py-1 font-mono text-xs">{r.capability}</td>
                    <td className="py-1">{r.quantity === null ? '-' : r.quantity >= 1_000_000 ? 'unlimited' : r.quantity}</td>
                    <td className="py-1">
                      {r.source}
                      {r.sourceRef ? <span className="text-xs text-muted"> · {r.sourceRef}</span> : null}
                    </td>
                    <td className="py-1">
                      {new Date(r.grantedAt).toLocaleDateString()} <span className="text-xs text-muted">by {r.grantedBy}</span>
                    </td>
                    <td className="py-1">{r.expiresAt ? new Date(r.expiresAt).toLocaleDateString() : '-'}</td>
                    <td className="py-1">{r.revokedAt ? `revoked (${r.revokedReason})` : 'active'}</td>
                    <td className="py-1 text-right">
                      {canChange && !r.revokedAt ? (
                        <button type="button" disabled={busy !== null} onClick={() => send('DELETE', { id: r.id }, r.id)} className="rounded-md border border-line px-2 py-1 text-xs">
                          {busy === r.id ? <Loader2 className="inline h-3 w-3 animate-spin" /> : 'Revoke'}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {canChange ? (
            <Card>
              <h3 className="font-medium">Grant without a payment</h3>
              <p className="text-sm text-muted">A comp, a pilot, a licence paid by invoice, a goodwill bonus. The row is audited with your reason; it is revoked here, never by a refund.</p>
              <p className="mt-1 text-sm text-muted">
                Grants only ever raise the answer. To take an account BELOW what its plan or the free baseline gives, add a <code>cap</code> row: a ceiling on a quantity, or a block on a boolean. Revoking a plan row here holds until staff grant it again - a plan re-sync, a recovered payment or a replayed webhook does not undo a staff revocation.
              </p>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <label className="flex flex-col text-sm">
                  <span className="text-muted">Capability</span>
                  <select className="rounded-md border border-line bg-surface px-3 py-2" value={capability} onChange={(e) => setCapability(e.target.value)}>
                    {capabilities.map((c) => (
                      <option key={c.key} value={c.key}>
                        {c.key} ({c.kind})
                      </option>
                    ))}
                  </select>
                  <span className="mt-1 text-xs text-muted">{capabilities.find((c) => c.key === capability)?.description}</span>
                </label>
                {kind === 'quantity' ? (
                  <label className="flex flex-col text-sm">
                    <span className="text-muted">Quantity (1000000 = unlimited)</span>
                    <input className="rounded-md border border-line bg-surface px-3 py-2" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
                  </label>
                ) : null}
                <label className="flex flex-col text-sm">
                  <span className="text-muted">Source</span>
                  <select className="rounded-md border border-line bg-surface px-3 py-2" value={source} onChange={(e) => setSource(e.target.value as (typeof SOURCES)[number])}>
                    {SOURCES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col text-sm">
                  <span className="text-muted">Expires (optional)</span>
                  <input type="date" className="rounded-md border border-line bg-surface px-3 py-2" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
                </label>
              </div>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => send('POST', { userId: user.id, capability, quantity: kind === 'quantity' ? Number(quantity) : undefined, source, expiresAt: expiresAt || undefined }, 'grant')}
                className="mt-3 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white"
              >
                {busy === 'grant' ? <Loader2 className="inline h-4 w-4 animate-spin" /> : 'Grant'}
              </button>
            </Card>
          ) : null}
        </>
      ) : lookupEmail ? (
        <Card>
          <p className="text-sm">No account with that email.</p>
        </Card>
      ) : null}

      {canChange ? (
        <Card>
          <h3 className="font-medium">Your password and reason (every change)</h3>
          <div className="mt-2 grid gap-3 md:grid-cols-2">
            <input type="password" autoComplete="current-password" className="rounded-md border border-line bg-surface px-3 py-2 text-sm" placeholder="Current password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <input className="rounded-md border border-line bg-surface px-3 py-2 text-sm" placeholder="Reason (goes into the audit row)" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          {message ? (
            <p className={cn('mt-2 flex items-center gap-2 text-sm', message.ok ? 'text-success' : 'text-danger')}>
              {message.ok ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
              {message.text}
            </p>
          ) : null}
        </Card>
      ) : null}

      <Card>
        <h3 className="font-medium">Recent entitlement audit</h3>
        <ul className="mt-2 divide-y divide-line text-sm">
          {audit.map((a) => (
            <li key={a.id} className="py-2">
              <span className="font-mono text-xs text-muted">{a.action}</span> {a.summary}
              <span className="text-muted">
                {' '}
                · {a.actorEmail || 'system'} · {new Date(a.createdAt).toLocaleString()}
                {a.reason ? ` · ${a.reason}` : ''}
              </span>
            </li>
          ))}
          {audit.length === 0 ? <li className="py-2 text-muted">Nothing yet.</li> : null}
        </ul>
      </Card>
    </div>
  );
}
