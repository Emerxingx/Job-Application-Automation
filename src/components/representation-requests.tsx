'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Card } from '@/components/ui';

export interface RepresentationView {
  id: string;
  agency: string;
  engagement: { title: string; clientName: string; jurisdiction: string };
  status: string;
  message: string;
}

/**
 * Stage 19 (ADR-0034): the CANDIDATE's side of agency representation. An
 * agency asks to represent this person for one engagement; consenting writes
 * a consent record for that agency and that engagement only, and revoking
 * takes it back. The wording here is a draft until counsel settles L-5.
 */
export function RepresentationRequests({ representations }: { representations: RepresentationView[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (representations.length === 0) return null;

  async function act(id: string, action: 'grant' | 'decline' | 'revoke') {
    if (action === 'revoke' && !window.confirm('Withdraw your consent to be represented? The agency cannot make a new placement for you under it; a placement already made stays as its record.')) return;
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/representations/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Could not update the request.');
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
      <h2 className="font-semibold text-ink">Staffing agencies asking to represent you</h2>
      <p className="mt-1 text-sm text-muted">
        A staffing agency can ask to put you forward for one specific role with one of its clients. Consenting lets that agency record a placement for you under that engagement; the client pays the agency&rsquo;s fee and you are never charged. You can withdraw at any time. (Consent wording: draft, pending legal review.)
      </p>
      {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
      <ul className="mt-4 space-y-3">
        {representations.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line p-3 text-sm">
            <div>
              <p className="font-medium text-ink">{r.agency}</p>
              <p className="text-xs text-muted">
                {r.engagement.title} for {r.engagement.clientName} ({r.engagement.jurisdiction}) · {r.status === 'requested' ? 'waiting for your answer' : r.status}
              </p>
              {r.message ? <p className="mt-1 text-xs text-muted">&ldquo;{r.message}&rdquo;</p> : null}
            </div>
            <div className="flex gap-2">
              {r.status === 'requested' ? (
                <>
                  <button type="button" className="btn-primary text-xs" disabled={busy !== null} onClick={() => act(r.id, 'grant')}>
                    {busy === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                    Consent to representation
                  </button>
                  <button type="button" className="rounded-md border border-line px-3 py-2 text-xs text-muted" disabled={busy !== null} onClick={() => act(r.id, 'decline')}>
                    Decline
                  </button>
                </>
              ) : r.status === 'granted' ? (
                <button type="button" className="rounded-md border border-line px-3 py-2 text-xs text-danger" disabled={busy !== null} onClick={() => act(r.id, 'revoke')}>
                  Withdraw consent
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
