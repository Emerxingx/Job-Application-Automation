'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, cn } from '@/components/ui';

export interface UserAdminView {
  id: string;
  email: string;
  fullName: string;
  role: string;
  anonymized: boolean;
  onboarded: boolean;
  createdAt: string;
  sessions: { id: string; method: string; createdAt: string; lastSeenAt: string; expiresAt: string }[];
  memberships: { organizationId: string; name: string; type: string; status: string; role: string; serviceRole: string | null; accepted: boolean }[];
}

export function UsersAdmin({ canChange, selfId, lookupEmail, user, impersonations }: { canChange: boolean; selfId: string; lookupEmail: string; user: UserAdminView | null; impersonations: { id: string; staffEmail: string; targetEmail: string; reason: string; startedAt: string; endedAt: string | null }[] }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState('');
  const [role, setRole] = useState(user?.role ?? 'member');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function call(key: string, url: string, method: string, body: Record<string, unknown>, onOk?: (data: Record<string, unknown>) => void) {
    if (!password || !reason) {
      setMessage({ ok: false, text: 'Enter your current password and a reason first.' });
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
      setMessage({ ok: true, text: 'Done and audited.' });
      onOk?.(data);
      router.refresh();
    } catch {
      setMessage({ ok: false, text: 'Could not reach the server.' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <form method="get" className="flex gap-2">
        <input name="email" type="email" defaultValue={lookupEmail} placeholder="person@example.com" className="w-80 rounded-md border border-line bg-surface px-3 py-2 text-sm" />
        <button type="submit" className="btn-secondary text-sm">
          Look up
        </button>
      </form>
      {message ? <p className={cn('text-sm', message.ok ? 'text-success' : 'text-danger')}>{message.text}</p> : null}
      {lookupEmail && !user ? <p className="text-sm text-muted">No account with that address.</p> : null}
      {user ? (
        <>
          <Card className="p-5">
            <h2 className="text-base font-semibold text-ink">
              {user.fullName} <span className="text-sm font-normal text-muted">{user.email}</span>
            </h2>
            <p className="mt-1 text-sm text-muted">
              Role <strong>{user.role}</strong> · created {new Date(user.createdAt).toLocaleDateString('en-CA')} · {user.onboarded ? 'onboarded' : 'not onboarded'}
              {user.anonymized ? ' · ERASED' : ''}
            </p>
            <h3 className="mt-3 text-sm font-medium text-ink">Memberships</h3>
            <ul className="text-sm text-muted">
              {user.memberships.length === 0 ? <li>None beyond the personal workspace.</li> : null}
              {user.memberships.map((m) => (
                <li key={m.organizationId}>
                  {m.name} ({m.type}, {m.status}) · {m.role}
                  {m.serviceRole ? ` / ${m.serviceRole}` : ''} · {m.accepted ? 'active' : 'invited'}
                </li>
              ))}
            </ul>
            <h3 className="mt-3 text-sm font-medium text-ink">Live sessions ({user.sessions.length})</h3>
            <ul className="text-xs text-muted">
              {user.sessions.map((s) => (
                <li key={s.id}>
                  {s.method} · since {new Date(s.createdAt).toLocaleString('en-CA')} · last seen {new Date(s.lastSeenAt).toLocaleString('en-CA')} · expires {new Date(s.expiresAt).toLocaleString('en-CA')}
                </li>
              ))}
            </ul>
          </Card>
          {canChange && !user.anonymized ? (
            <Card className="p-5">
              <h2 className="text-base font-semibold text-ink">Actions (re-authenticated, audited)</h2>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <label className="flex flex-col text-sm">
                  <span className="text-muted">Your current password</span>
                  <input type="password" autoComplete="current-password" className="rounded-md border border-line bg-surface px-3 py-2" value={password} onChange={(e) => setPassword(e.target.value)} />
                </label>
                <label className="flex flex-col text-sm">
                  <span className="text-muted">Reason</span>
                  <input className="rounded-md border border-line bg-surface px-3 py-2" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="the ticket, the request, what you need to see" />
                </label>
              </div>
              <div className="mt-3 flex flex-wrap items-end gap-3">
                <label className="flex flex-col text-sm">
                  <span className="text-muted">Platform role</span>
                  <select className="rounded-md border border-line bg-surface px-3 py-2" value={role} disabled={user.id === selfId} onChange={(e) => setRole(e.target.value)}>
                    <option value="member">member</option>
                    <option value="support">support</option>
                    <option value="billing_ops">billing_ops</option>
                    <option value="admin">admin</option>
                  </select>
                </label>
                <button type="button" className="btn-primary text-sm" disabled={busy !== null || user.id === selfId || role === user.role} onClick={() => call('role', '/api/console/users', 'PATCH', { action: 'role', userId: user.id, role })}>
                  Set role
                </button>
                <button type="button" className="rounded-md border border-line px-3 py-2 text-sm text-danger" disabled={busy !== null} onClick={() => call('revoke', '/api/console/users', 'PATCH', { action: 'revoke_sessions', userId: user.id })}>
                  Sign out everywhere
                </button>
                {user.role === 'member' ? (
                  <button type="button" className="btn-secondary text-sm" disabled={busy !== null} onClick={() => call('imp', '/api/console/impersonation', 'POST', { userId: user.id }, (data) => window.location.assign(((data.impersonation as { redirect?: string })?.redirect) ?? '/dashboard'))}>
                    Impersonate (read-only, 60 min)
                  </button>
                ) : null}
              </div>
              {user.id === selfId ? <p className="mt-2 text-xs text-muted">You cannot change your own role.</p> : null}
            </Card>
          ) : null}
        </>
      ) : null}
      {impersonations.length ? (
        <Card className="p-5">
          <h2 className="text-base font-semibold text-ink">Recent impersonations</h2>
          <ul className="mt-2 divide-y divide-line text-sm">
            {impersonations.map((i) => (
              <li key={i.id} className="py-2">
                <span className="text-ink">{i.staffEmail}</span> viewed <span className="text-ink">{i.targetEmail}</span> · {new Date(i.startedAt).toLocaleString('en-CA')} · {i.endedAt ? `ended ${new Date(i.endedAt).toLocaleTimeString('en-CA')}` : 'open (expires after 60 min)'}
                <p className="text-xs text-muted">{i.reason}</p>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
