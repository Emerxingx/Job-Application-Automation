'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, RefreshCw } from 'lucide-react';
import { cn } from '@/components/ui';

/**
 * Triggers a live scan. Without an agentId it runs every active agent.
 */
export function ScanButton({
  agentId,
  label = 'Scan now',
  variant = 'primary',
}: {
  agentId?: string;
  label?: string;
  variant?: 'primary' | 'secondary';
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function scan() {
    setLoading(true);
    setMessage(null);

    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(agentId ? { agentId } : {}),
      });
      const data = await res.json();

      if (!res.ok) {
        setMessage(data.error ?? 'Scan failed.');
        return;
      }

      // Surface agent failures rather than reporting a misleading "0 found".
      if (data.errors?.length) {
        setMessage(`${data.errors[0].agentName}: ${data.errors[0].message}`);
        router.refresh();
        return;
      }

      const { scanned, newMatches, excluded = 0 } = data.totals;
      setMessage(
        newMatches > 0
          ? `Found ${newMatches} new match${newMatches === 1 ? '' : 'es'} across ${scanned} postings${excluded ? ` (${excluded} excluded as ineligible — see the feed for why)` : ''}.`
          : `Scanned ${scanned} postings — nothing new above your match threshold.`,
      );
      router.refresh();
    } catch {
      setMessage('Could not reach the server.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <button
        onClick={scan}
        disabled={loading}
        className={cn(variant === 'primary' ? 'btn-primary' : 'btn-secondary')}
      >
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <RefreshCw className="h-4 w-4" />
        )}
        {loading ? 'Scanning…' : label}
      </button>
      {message && (
        <p role="status" className="max-w-xs text-right text-xs text-muted">
          {message}
        </p>
      )}
    </div>
  );
}
