'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, cn } from '@/components/ui';

export interface OrganizationDetailView {
  id: string;
  status: string;
  policy: { requireSso: boolean; allowedEmailDomains: string[]; sessionMaxHours: number | null };
  sso: { issuer: string; clientId: string; emailDomain: string; jitProvisioning: boolean; status: string; lastSignInAt: string | null } | null;
  scimTokens: { id: string; prefix: string; createdByEmail: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }[];
  members: { userId: string; email: string; fullName: string; role: string; serviceRole: string | null; acceptedAt: string | null; removedAt: string | null }[];
}

/** Stage 20 (ADR-0035): one organisation's controls. Every write asks for the staff member's password and a reason; the server re-authenticates and audits. */
export function OrganizationDetailAdmin({ canChange, ssoKeyPresent, organization: o }: { canChange: boolean; ssoKeyPresent: boolean; organization: OrganizationDetailView }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [policy, setPolicy] = useState({ requireSso: o.policy.requireSso, domains: o.policy.allowedEmailDomains.join(', '), sessionMaxHours: o.policy.sessionMaxHours === null ? '' : String(o.policy.sessionMaxHours) });
  const [sso, setSso] = useState({ issuer: o.sso?.issuer ?? '', clientId: o.sso?.clientId ?? '', clientSecret: '', emailDomain: o.sso?.emailDomain ?? '', jitProvisioning: o.sso?.jitProvisioning ?? true, status: o.sso?.status ?? 'disabled' });
  const [issued, setIssued] = useState<{ prefix: string; token: string } | null>(null);

  async function call(key: string, url: string, method: string, body: Record<string, unknown>, onOk?: (data: Record<string, unknown>) => void) {
    if (!password || !reason) {
      setMessage({ ok: false, text: 'Enter your current password and a reason first - every change is re-authenticated and audited.' });
      return;
    }
    setBusy(key);
    setMessage(null);
    try {
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: password, reason, ...body }) });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ ok: false, text: data.error ?? 'The change was refused.' });
        return;
      }
      setMessage({ ok: true, text: 'Saved and audited.' });
      onOk?.(data);
      router.refresh();
    } catch {
      setMessage({ ok: false, text: 'Could not reach the server.' });
    } finally {
      setBusy(null);
    }
  }

  const base = `/api/console/organizations/${o.id}`;

  return (
    <div className="space-y-4">
      {message ? <p className={cn('text-sm', message.ok ? 'text-success' : 'text-danger')}>{message.text}</p> : null}
      {canChange ? (
        <Card className="p-5">
          <h2 className="text-base font-semibold text-ink">Your password and reason (every change)</h2>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="flex flex-col text-sm">
              <span className="text-muted">Current password</span>
              <input type="password" autoComplete="current-password" className="rounded-md border border-line bg-surface px-3 py-2" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <label className="flex flex-col text-sm">
              <span className="text-muted">Reason (audited)</span>
              <input className="rounded-md border border-line bg-surface px-3 py-2" value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
          </div>
        </Card>
      ) : null}

      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-ink">Status: {o.status}</h2>
            <p className="text-sm text-muted">A suspended organisation keeps its rows; its members cannot act in it, its SSO signs nobody in and its SCIM tokens are refused until it is reactivated.</p>
          </div>
          {canChange ? (
            <button type="button" className={o.status === 'suspended' ? 'btn-primary text-sm' : 'rounded-md border border-line px-3 py-2 text-sm text-danger'} disabled={busy !== null} onClick={() => call('status', base, 'PATCH', { action: 'status', status: o.status === 'suspended' ? 'active' : 'suspended' })}>
              {o.status === 'suspended' ? 'Reactivate' : 'Suspend'}
            </button>
          ) : null}
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="text-base font-semibold text-ink">Tenant policy</h2>
        <p className="text-sm text-muted">Set by JobPilot staff, never by the organisation&rsquo;s own admins. A policy narrows what members may do; it never widens a platform rule.</p>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={policy.requireSso} disabled={!canChange} onChange={(e) => setPolicy({ ...policy, requireSso: e.target.checked })} />
            <span>Require SSO for the connection&rsquo;s domain (password and identity-provider sign-in refused)</span>
          </label>
          <label className="flex flex-col text-sm">
            <span className="text-muted">Allowed email domains (comma-separated; empty = any)</span>
            <input className="rounded-md border border-line bg-surface px-3 py-2" disabled={!canChange} value={policy.domains} onChange={(e) => setPolicy({ ...policy, domains: e.target.value })} />
          </label>
          <label className="flex flex-col text-sm">
            <span className="text-muted">Session ceiling (hours; empty = platform 30 days)</span>
            <input type="number" min={1} max={720} className="rounded-md border border-line bg-surface px-3 py-2" disabled={!canChange} value={policy.sessionMaxHours} onChange={(e) => setPolicy({ ...policy, sessionMaxHours: e.target.value })} />
          </label>
        </div>
        {canChange ? (
          <button type="button" className="btn-primary mt-3 text-sm" disabled={busy !== null} onClick={() => call('policy', base, 'PATCH', { action: 'policy', requireSso: policy.requireSso, allowedEmailDomains: policy.domains.split(',').map((d) => d.trim()).filter(Boolean), sessionMaxHours: policy.sessionMaxHours === '' ? null : Number(policy.sessionMaxHours) })}>
            Save policy
          </button>
        ) : null}
      </Card>

      <Card className="p-5">
        <h2 className="text-base font-semibold text-ink">Single sign-on (OpenID Connect)</h2>
        <p className="text-sm text-muted">
          One connection, authoritative for one email domain. The client secret is encrypted at rest and never shown again. {o.sso?.lastSignInAt ? `Last sign-in ${new Date(o.sso.lastSignInAt).toLocaleString('en-CA')}.` : 'No sign-in has happened through it yet.'} No real identity provider has been validated against this platform (INTEGRATION_REGISTER.md).
        </p>
        {!ssoKeyPresent ? <p className="mt-2 text-sm text-danger">SSO_ENCRYPTION_KEY is not set on this deployment: a client secret cannot be stored, so no connection can be created.</p> : null}
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <label className="flex flex-col text-sm">
            <span className="text-muted">Issuer URL</span>
            <input className="rounded-md border border-line bg-surface px-3 py-2" disabled={!canChange} value={sso.issuer} onChange={(e) => setSso({ ...sso, issuer: e.target.value })} placeholder="https://login.example.com/tenant" />
          </label>
          <label className="flex flex-col text-sm">
            <span className="text-muted">Client id</span>
            <input className="rounded-md border border-line bg-surface px-3 py-2" disabled={!canChange} value={sso.clientId} onChange={(e) => setSso({ ...sso, clientId: e.target.value })} />
          </label>
          <label className="flex flex-col text-sm">
            <span className="text-muted">Client secret ({o.sso ? 'leave blank to keep the stored one' : 'required'})</span>
            <input type="password" autoComplete="off" className="rounded-md border border-line bg-surface px-3 py-2" disabled={!canChange} value={sso.clientSecret} onChange={(e) => setSso({ ...sso, clientSecret: e.target.value })} />
          </label>
          <label className="flex flex-col text-sm">
            <span className="text-muted">Email domain</span>
            <input className="rounded-md border border-line bg-surface px-3 py-2" disabled={!canChange} value={sso.emailDomain} onChange={(e) => setSso({ ...sso, emailDomain: e.target.value })} placeholder="example.com" />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={sso.jitProvisioning} disabled={!canChange} onChange={(e) => setSso({ ...sso, jitProvisioning: e.target.checked })} />
            <span>Provision an account and membership at first sign-in</span>
          </label>
          <label className="flex flex-col text-sm">
            <span className="text-muted">Status</span>
            <select className="rounded-md border border-line bg-surface px-3 py-2" disabled={!canChange} value={sso.status} onChange={(e) => setSso({ ...sso, status: e.target.value })}>
              <option value="disabled">disabled</option>
              <option value="enabled">enabled</option>
            </select>
          </label>
        </div>
        {canChange ? (
          <button type="button" className="btn-primary mt-3 text-sm" disabled={busy !== null || !ssoKeyPresent} onClick={() => call('sso', `${base}/sso`, 'PUT', { issuer: sso.issuer, clientId: sso.clientId, clientSecret: sso.clientSecret || undefined, emailDomain: sso.emailDomain, jitProvisioning: sso.jitProvisioning, status: sso.status }, () => setSso({ ...sso, clientSecret: '' }))}>
            Save connection
          </button>
        ) : null}
      </Card>

      <Card className="p-5">
        <h2 className="text-base font-semibold text-ink">SCIM provisioning tokens</h2>
        <p className="text-sm text-muted">A token lets the organisation&rsquo;s identity provider create and deactivate memberships at /api/scim/v2 (Users only). Shown once at issue; stored as a digest. Deactivation removes the membership and signs the person out; it never deletes their account.</p>
        {issued ? (
          <p className="mt-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-ink">
            Token <strong>{issued.prefix}</strong> - copy it now; it will not be shown again: <code className="break-all">{issued.token}</code>
          </p>
        ) : null}
        <ul className="mt-2 divide-y divide-line text-sm">
          {o.scimTokens.length === 0 ? <li className="py-2 text-muted">No tokens.</li> : null}
          {o.scimTokens.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                <code>{t.prefix}</code> · issued by {t.createdByEmail} on {new Date(t.createdAt).toLocaleDateString('en-CA')} · {t.revokedAt ? `revoked ${new Date(t.revokedAt).toLocaleDateString('en-CA')}` : t.lastUsedAt ? `last used ${new Date(t.lastUsedAt).toLocaleString('en-CA')}` : 'never used'}
              </span>
              {canChange && !t.revokedAt ? (
                <button type="button" className="rounded-md border border-line px-3 py-1 text-xs text-danger" disabled={busy !== null} onClick={() => call(`rev-${t.id}`, `${base}/scim-tokens`, 'DELETE', { tokenId: t.id })}>
                  Revoke
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {canChange ? (
          <button type="button" className="btn-secondary mt-3 text-sm" disabled={busy !== null} onClick={() => call('issue', `${base}/scim-tokens`, 'POST', {}, (data) => setIssued((data.token as { prefix: string; token: string }) ?? null))}>
            Issue a token
          </button>
        ) : null}
      </Card>

      <Card className="p-0">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3">Member</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Service role</th>
              <th className="px-4 py-3">State</th>
            </tr>
          </thead>
          <tbody>
            {o.members.map((m) => (
              <tr key={m.userId} className="border-t border-line">
                <td className="px-4 py-2">
                  <span className="text-ink">{m.fullName}</span> <span className="text-xs text-muted">{m.email}</span>
                </td>
                <td className="px-4 py-2 text-muted">{m.role}</td>
                <td className="px-4 py-2 text-muted">{m.serviceRole ?? '—'}</td>
                <td className="px-4 py-2 text-xs text-muted">{m.removedAt ? 'removed' : m.acceptedAt ? 'active' : 'invited'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
