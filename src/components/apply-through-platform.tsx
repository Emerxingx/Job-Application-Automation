'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Card } from '@/components/ui';

/**
 * Stage 18 (ADR-0033): applying to an employer's posting ON this platform.
 * The candidate's click enters that employer's pipeline and, by the same
 * act, grants that employer disclosure of their identity and profile.
 * Nothing is sent to any other system.
 */
export function ApplyThroughPlatform({ jobId, company, requisitionOpen, applied }: { jobId: string; company: string; requisitionOpen: boolean; applied: 'received' | 'withdrawn' | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function apply() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/disclosures/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId }) });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? 'Could not apply.');
      else router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="mt-4 p-5">
      <h2 className="text-sm font-semibold text-ink">Posted by {company} on JobPilot</h2>
      {applied === 'received' ? (
        <p className="mt-1 text-xs text-muted">Your application was received; {company} contacts you directly about next steps. Revoke the disclosure under Settings to withdraw it.</p>
      ) : applied === 'withdrawn' && !requisitionOpen ? (
        <p className="mt-1 text-xs text-muted">You withdrew your application, and this requisition is no longer open.</p>
      ) : requisitionOpen ? (
        <>
          <p className="mt-1 text-xs text-muted">{applied === 'withdrawn' ? 'You withdrew an earlier application. ' : ''}Applying here shows {company} your name, contact details and résumé - and only them. Your self-identification answers are never shared. You can revoke this under Settings.</p>
          {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
          <button type="button" className="btn-primary mt-3 w-full text-xs" disabled={busy} onClick={apply}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Apply through JobPilot
          </button>
        </>
      ) : (
        <p className="mt-1 text-xs text-muted">This requisition is not open for applications right now.</p>
      )}
    </Card>
  );
}
