'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarDays, Loader2, Mail, RefreshCw, ShieldCheck, Unplug } from 'lucide-react';
import { Card, cn } from '@/components/ui';

/**
 * Stage 11 — mailbox and calendar connections.
 *
 * Every connection is one explicit consent, one provider, one kind, and
 * metadata scopes only; the scope inventory is shown before the applicant
 * connects so what is asked for is exactly what they see. Revoking a
 * connection purges everything derived from it and says how much.
 */
export interface ConnectionView {
  id: string;
  provider: string;
  kind: string;
  accountEmail: string;
  scopes: string[];
  status: string;
  connectedLabel: string;
  lastSyncLabel: string | null;
  errorCode: string | null;
}

export interface ScopeView {
  provider: 'google' | 'microsoft';
  kind: 'mail' | 'calendar';
  scopes: string[];
  label: string;
  what: string;
}

const PROVIDER_LABEL: Record<string, string> = { google: 'Google', microsoft: 'Microsoft' };
const KIND_LABEL: Record<string, string> = { mail: 'Mailbox', calendar: 'Calendar' };
const STATUS_TONE: Record<string, string> = { connected: 'bg-success/10 text-success', revoked: 'bg-raised text-muted line-through', error: 'bg-danger/10 text-danger' };

export function MailboxConnections({ connections, scopes, notice }: { connections: ConnectionView[]; scopes: ScopeView[]; notice: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(notice ? { ok: notice === 'connected', text: NOTICES[notice] ?? notice } : null);
  const [consent, setConsent] = useState<Record<string, boolean>>({});

  async function connect(provider: 'google' | 'microsoft', kind: 'mail' | 'calendar') {
    const key = `${provider}:${kind}`;
    if (!consent[key]) {
      setMessage({ ok: false, text: 'Tick the consent box for that connection first.' });
      return;
    }
    setBusy(key);
    setMessage(null);
    try {
      const res = await fetch('/api/mailbox/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, kind, consent: true }) });
      const data = (await res.json()) as { error?: string; url?: string };
      if (!res.ok || !data.url) {
        setMessage({ ok: false, text: data.error ?? 'The connection could not be started.' });
        return;
      }
      window.location.assign(data.url);
    } catch {
      setMessage({ ok: false, text: 'The request could not be sent.' });
    } finally {
      setBusy(null);
    }
  }

  async function act(id: string, method: 'POST' | 'DELETE', path: string, done: (data: Record<string, unknown>) => string) {
    setBusy(id);
    setMessage(null);
    try {
      const res = await fetch(path, { method });
      const data = (await res.json()) as Record<string, unknown> & { error?: string };
      if (!res.ok) {
        setMessage({ ok: false, text: data.error ?? 'The change was refused.' });
        return;
      }
      setMessage({ ok: true, text: done(data) });
      router.refresh();
    } catch {
      setMessage({ ok: false, text: 'The request could not be sent.' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="mt-6 max-w-2xl p-6">
      <h2 className="font-semibold text-ink">Email and calendar</h2>
      <p className="mt-1 text-sm text-muted">
        JobPilot files employer email and interview invitations into the right application folder. It reads <span className="font-medium text-ink">headers only</span> — who wrote, when, and the subject — never a message body; nothing is sent on your behalf; and revoking a connection deletes everything derived from it.
      </p>
      <p role="status" aria-live="polite" className={cn('m-0 mt-2 text-sm', message?.ok ? 'text-success' : 'text-danger')}>
        {message?.text}
      </p>

      {connections.length > 0 && (
        <ul className="mt-4 divide-y divide-line">
          {connections.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 py-3">
              {c.kind === 'mail' ? <Mail className="h-4 w-4 shrink-0 text-faint" aria-hidden="true" /> : <CalendarDays className="h-4 w-4 shrink-0 text-faint" aria-hidden="true" />}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">
                  {PROVIDER_LABEL[c.provider] ?? c.provider} {KIND_LABEL[c.kind] ?? c.kind} · {c.accountEmail}
                </p>
                <p className="truncate text-xs text-faint">
                  <span className={cn('chip mr-1', STATUS_TONE[c.status] ?? 'bg-raised text-muted')}>{c.status}</span>
                  connected {c.connectedLabel}
                  {c.lastSyncLabel ? ` · last sync ${c.lastSyncLabel}` : ' · not synced yet'}
                  {c.errorCode ? ` · ${c.errorCode}` : ''} · scopes: {c.scopes.join(', ') || 'none recorded'}
                </p>
              </div>
              {c.status === 'connected' && (
                <>
                  <button type="button" className="btn-secondary px-3 py-1.5 text-xs" disabled={busy !== null} onClick={() => act(c.id, 'POST', `/api/mailbox/${c.id}/sync`, (d) => `Synced: ${JSON.stringify((d as { result?: unknown }).result ?? {})}`)}>
                    {busy === c.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />} Sync now
                  </button>
                  <button
                    type="button"
                    className="btn-ghost px-3 py-1.5 text-xs text-danger"
                    disabled={busy !== null}
                    onClick={() => {
                      if (window.confirm('Revoke this connection? Everything JobPilot derived from it — filed threads, references, detections — is deleted. The provider grant is invalidated where the provider allows it.')) {
                        void act(c.id, 'DELETE', `/api/mailbox/${c.id}`, (d) => {
                          const p = (d as { purged?: Record<string, number> }).purged ?? {};
                          return `Revoked. Purged ${p.threads ?? 0} threads, ${p.messages ?? 0} message references, ${p.calendarEvents ?? 0} calendar references, ${p.integrationEvents ?? 0} events and the stored token.`;
                        });
                      }
                    }}
                  >
                    <Unplug className="h-3.5 w-3.5" aria-hidden="true" /> Revoke
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        {scopes.map((s) => {
          const key = `${s.provider}:${s.kind}`;
          return (
            <div key={key} className="rounded-xl border border-line p-3">
              <p className="text-sm font-semibold text-ink">{s.label}</p>
              <p className="mt-0.5 text-xs text-muted">{s.what}</p>
              <p className="mt-1 font-mono text-[11px] text-faint">Asks for: {s.scopes.join(', ')}</p>
              <label className="mt-2 flex items-start gap-2 text-xs text-muted">
                <input type="checkbox" className="mt-0.5" checked={consent[key] ?? false} onChange={(e) => setConsent({ ...consent, [key]: e.target.checked })} />
                <span>I consent to JobPilot reading {s.kind === 'mail' ? 'message headers (sender, recipients, subject, date) — never bodies —' : 'event titles, times and attendees'} from this account, until I revoke it.</span>
              </label>
              <button type="button" className="btn-secondary mt-2 px-3 py-1.5 text-xs" disabled={busy !== null} onClick={() => connect(s.provider, s.kind)}>
                {busy === key ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />} Connect
              </button>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

const NOTICES: Record<string, string> = {
  connected: 'Connected. Use "Sync now" to file your recent employer email.',
  denied: 'The provider did not return a code; nothing was connected.',
  state: 'That sign-in did not start from your account, or it expired. Nothing was connected.',
  unavailable: 'This deployment cannot connect a mailbox yet (provider sign-in or the encryption key is not configured). Nothing was saved.',
  refused: 'The connection was refused — the grant did not match what was asked for. Nothing was saved.',
  failed: 'The provider could not be reached while finishing the sign-in. Nothing was saved; try again in a moment.',
};
