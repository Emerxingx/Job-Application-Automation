'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Card } from '@/components/ui';

export interface ClientCaseView {
  id: string;
  organization: string;
  status: string;
  consentedAt: string | null;
  createdAt: string;
}

/**
 * Stage 17 (ADR-0032): the CLIENT's side of case management. An employment
 * service provider invited this person; nothing about them is read until
 * they accept here (a consent record is written), and withdrawing closes
 * the case and revokes that consent.
 */
export function CaseInvitations({ cases }: { cases: ClientCaseView[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (cases.length === 0) return null;

  async function act(id: string, action: 'accept' | 'decline' | 'withdraw') {
    if (action === 'withdraw' && !window.confirm('Withdraw from this case? The organisation loses access to your job-search data from now on. Records it already made are kept under its retention policy.')) return;
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/cases/invitations/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Could not update the case.');
        return;
      }
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="mt-6 max-w-2xl p-6">
      <h2 className="font-semibold text-ink">Employment services</h2>
      <p className="mt-1 text-sm text-muted">
        An employment service provider can work alongside you on this platform. When you accept, its case manager can see your applications, interviews, eligibility results and compatibility scores - never your self-identification answers - and every look is recorded. You can withdraw at any time.
      </p>
      <ul className="mt-4 space-y-3">
        {cases.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line p-3 text-sm">
            <div>
              <p className="font-medium text-ink">{c.organization}</p>
              <p className="text-xs text-muted">
                {c.status === 'invited' ? 'Invitation waiting for your answer' : c.status === 'open' ? `Consented ${c.consentedAt ? new Date(c.consentedAt).toLocaleDateString('en-CA') : ''}` : c.status}
              </p>
            </div>
            <div className="flex gap-2">
              {c.status === 'invited' ? (
                <>
                  <button type="button" className="btn-primary text-xs" disabled={busy !== null} onClick={() => act(c.id, 'accept')}>
                    {busy === c.id ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                    Accept and consent
                  </button>
                  <button type="button" className="rounded-md border border-line px-3 py-2 text-xs text-muted" disabled={busy !== null} onClick={() => act(c.id, 'decline')}>
                    Decline
                  </button>
                </>
              ) : c.status === 'open' ? (
                <button type="button" className="rounded-md border border-line px-3 py-2 text-xs text-danger" disabled={busy !== null} onClick={() => act(c.id, 'withdraw')}>
                  Withdraw consent
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
