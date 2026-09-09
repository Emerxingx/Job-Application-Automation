'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, RefreshCw } from 'lucide-react';

/**
 * Stage 13 - a dashboard that reads marts must say how fresh they are
 * (ADR-0012 rule 4) and let the candidate rebuild their own rows on demand.
 * Since Stage 24 the worker rebuilds the marts nightly; the operator's sweep and this button are the other
 * refreshes, so the timestamp is the truth, not decoration.
 */
export function AnalyticsFreshness({ lastSucceededAt, lastStatus, stale }: { lastSucceededAt: string | null; lastStatus: string | null; /** Computed on the server: more than a day old, or never built. */ stale: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/analytics/refresh', { method: 'POST' });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? 'The refresh was refused.');
        return;
      }
      router.refresh();
    } catch {
      setError('The refresh could not be requested.');
    } finally {
      setBusy(false);
    }
  }

  const when = lastSucceededAt ? new Date(lastSucceededAt) : null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
      <span className={stale ? 'text-warn' : ''}>
        {when ? `Numbers as of ${when.toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'Numbers not built yet'}
        {stale && when ? ' - more than a day old' : ''}
        {lastStatus === 'failed' ? ' - the last rebuild failed' : ''}
      </span>
      <button type="button" className="btn-ghost px-2 py-1 text-xs" disabled={busy} onClick={refresh}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />} Refresh
      </button>
      {error && <span className="text-danger">{error}</span>}
    </div>
  );
}
