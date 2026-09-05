'use client';

import { useEffect, useState } from 'react';

type Status = { status: 'none' | 'scheduled' | 'canceled' | 'completed'; scheduledFor: string | null; completedAt: string | null };

/**
 * Stage 23 (ADR-0037) - the account holder's erasure control. Schedules an
 * erasure with a fourteen-day grace period, shows the date, and lets the
 * person cancel within it. The copy says exactly what leaves and what is
 * retained, because "delete my account" must not promise what the statute
 * forbids.
 */
export function AccountErasure() {
  const [state, setState] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function load() {
    const res = await fetch('/api/account/erasure', { cache: 'no-store' });
    if (res.ok) setState((await res.json()) as Status);
  }
  useEffect(() => {
    void load();
  }, []);

  async function request() {
    setBusy(true);
    setError(null);
    const res = await fetch('/api/account/erasure', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    const body = (await res.json().catch(() => ({}))) as Partial<Status> & { error?: string };
    if (!res.ok) setError(body.error ?? 'Could not schedule the erasure.');
    else setState(body.status ? (body as Status) : null);
    setConfirming(false);
    setBusy(false);
  }

  async function cancel() {
    setBusy(true);
    setError(null);
    const res = await fetch('/api/account/erasure', { method: 'DELETE' });
    const body = (await res.json().catch(() => ({}))) as Partial<Status> & { error?: string };
    if (!res.ok) setError(body.error ?? 'Could not cancel.');
    else setState(body.status ? (body as Status) : null);
    setBusy(false);
  }

  const scheduled = state?.status === 'scheduled' && state.scheduledFor ? new Date(state.scheduledFor) : null;

  return (
    <div className="mt-4 rounded-lg border border-line p-4" aria-live="polite">
      <h3 className="text-sm font-semibold text-ink">Delete your account</h3>
      <p className="mt-1 text-xs text-muted">
        Deletion is scheduled fourteen days out and you can cancel it until then. When it runs, your profile, evidence, résumés, applications and their files, plans, mailbox connections, sessions and keys are deleted and your account record is scrubbed. Invoices and payments are kept for seven years as the law requires, with your identity removed; a service provider&apos;s or employer&apos;s own records about you keep their ids only. Your answers to application questions and your integrations are deleted; the audit trail keeps what happened, with your address removed. A payment provider keeps its own customer record under its own privacy terms - erasure here does not reach it. An active subscription must be cancelled first, and an organisation you are the only owner of must be handed over.
      </p>
      {scheduled ? (
        <p className="mt-3 text-sm text-ink">
          Scheduled for <strong>{scheduled.toISOString().slice(0, 10)}</strong>.{' '}
          <button type="button" onClick={cancel} disabled={busy} className="underline">
            Cancel the deletion
          </button>
        </p>
      ) : state?.status === 'completed' ? (
        <p className="mt-3 text-sm text-muted">This account has been erased.</p>
      ) : confirming ? (
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <span className="text-ink">Schedule the deletion of this account?</span>
          <button type="button" onClick={request} disabled={busy} className="rounded-md bg-danger px-3 py-1.5 text-white">
            Yes, schedule it
          </button>
          <button type="button" onClick={() => setConfirming(false)} disabled={busy} className="underline">
            Keep my account
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setConfirming(true)} disabled={busy || state === null} className="mt-3 rounded-md border border-line px-3 py-1.5 text-sm text-ink">
          Delete my account…
        </button>
      )}
      {error ? (
        <p className="mt-2 text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
