'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Pause, Play, Trash2 } from 'lucide-react';

export function AgentActions({ agentId, status }: { agentId: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    await fetch(`/api/agents/${agentId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: status === 'active' ? 'paused' : 'active' }),
    });
    setBusy(false);
    router.refresh();
  }

  async function remove() {
    // Deleting an agent removes its matches, so confirm before proceeding.
    if (!confirm('Delete this agent? Its saved matches will be removed. Applications you have already sent are kept.')) {
      return;
    }
    setBusy(true);
    await fetch(`/api/agents/${agentId}`, { method: 'DELETE' });
    setBusy(false);
    router.refresh();
  }

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={toggle}
        disabled={busy}
        className="btn-ghost px-2.5 py-1.5 text-xs"
        aria-label={status === 'active' ? 'Pause agent' : 'Resume agent'}
      >
        {status === 'active' ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        {status === 'active' ? 'Pause' : 'Resume'}
      </button>
      <button
        onClick={remove}
        disabled={busy}
        className="btn-ghost px-2.5 py-1.5 text-xs hover:text-danger"
        aria-label="Delete agent"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
