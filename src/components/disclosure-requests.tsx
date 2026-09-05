'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Card } from '@/components/ui';

export interface DisclosureView {
  id: string;
  organization: string;
  requisitionTitle: string | null;
  status: string;
  message: string;
  requestedAt: string;
}

/**
 * Stage 18 (ADR-0033): the CANDIDATE's side of employer disclosure. An
 * employer that found this person through anonymised sourcing asks to see
 * who they are; granting writes a consent record for THAT employer only,
 * and revoking takes it back (the employer's pipeline entries for them are
 * withdrawn). The wording a candidate reads here is a draft until counsel
 * settles L-5.
 */
export function DisclosureRequests({ disclosures }: { disclosures: DisclosureView[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (disclosures.length === 0) return null;

  async function act(id: string, action: 'grant' | 'decline' | 'revoke') {
    if (action === 'revoke' && !window.confirm('Revoke this disclosure? The employer loses access to your identity and profile from now on, and any application in their pipeline is withdrawn.')) return;
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/disclosures/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
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
      <h2 className="font-semibold text-ink">Employers who asked to see your profile</h2>
      <p className="mt-1 text-sm text-muted">
        Employers hiring on this platform can search candidates who chose to be visible to recruiters, seeing a fit score and region only. Granting a request shows that one employer your name, contact details and résumé; it never shows your self-identification answers. You can revoke it at any time. (Consent wording: draft, pending legal review.)
      </p>
      {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
      <ul className="mt-4 space-y-3">
        {disclosures.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line p-3 text-sm">
            <div>
              <p className="font-medium text-ink">{d.organization}</p>
              <p className="text-xs text-muted">
                {d.requisitionTitle ? `${d.requisitionTitle} · ` : ''}
                {d.status === 'requested' ? 'waiting for your answer' : d.status}
              </p>
              {d.message ? <p className="mt-1 text-xs text-muted">&ldquo;{d.message}&rdquo;</p> : null}
            </div>
            <div className="flex gap-2">
              {d.status === 'requested' ? (
                <>
                  <button type="button" className="btn-primary text-xs" disabled={busy !== null} onClick={() => act(d.id, 'grant')}>
                    {busy === d.id ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                    Show them my profile
                  </button>
                  <button type="button" className="rounded-md border border-line px-3 py-2 text-xs text-muted" disabled={busy !== null} onClick={() => act(d.id, 'decline')}>
                    Decline
                  </button>
                </>
              ) : d.status === 'granted' ? (
                <button type="button" className="rounded-md border border-line px-3 py-2 text-xs text-danger" disabled={busy !== null} onClick={() => act(d.id, 'revoke')}>
                  Revoke
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
