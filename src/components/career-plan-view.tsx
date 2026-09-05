'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Card, cn } from '@/components/ui';
import type { PlanView } from '@/lib/career/service';

const STATUS_LABEL: Record<string, string> = { planned: 'Planned', in_progress: 'In progress', done: 'Done', dropped: 'Dropped' };
const KIND_LABEL: Record<string, string> = { credential: 'Credential', learning: 'Learning', experience: 'Experience', other: 'Other' };

/**
 * Stage 16 (ADR-0031): the milestones of one plan version, moved by the
 * person. `done` may cite an approved evidence claim from the vault; the
 * milestone is then backed by something the documents can also say.
 */
export function CareerPlanMilestones({ plan, evidence }: { plan: PlanView; evidence: { id: string; claim: string }[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState(plan.milestones);
  const archived = plan.status === 'archived';

  async function update(id: string, patch: { status: string; evidenceId?: string | null }) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/career/milestones/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Could not update the milestone.');
        return;
      }
      setRows((prev) => prev.map((m) => (m.id === id ? { ...m, status: data.milestone.status, completedAt: data.milestone.completedAt, evidenceId: data.milestone.evidenceId } : m)));
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(null);
    }
  }

  async function act(action: 'refresh' | 'archive') {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/api/career/plans/${plan.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Could not update the plan.');
        return;
      }
      if (action === 'refresh') router.push(`/dashboard/career/${data.plan.id}`);
      else router.push('/dashboard/career');
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(null);
    }
  }

  const done = rows.filter((m) => m.status === 'done').length;
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-ink">Milestones</h2>
        <span className="text-xs text-muted">
          {done} of {rows.length} done
        </span>
      </div>
      {rows.length === 0 ? <p className="mt-2 text-sm text-muted">Nothing to do: your profile already meets what the target lists. Keep the evidence vault current.</p> : null}
      <ol className="mt-3 space-y-3">
        {rows.map((m) => (
          <li key={m.id} className="rounded-md border border-line p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">
                  <span className="mr-2 rounded bg-raised px-1.5 py-0.5 text-xs text-muted">{KIND_LABEL[m.kind] ?? m.kind}</span>
                  {m.title}
                </p>
                {m.note ? <p className="mt-1 text-xs text-muted">{m.note}</p> : null}
              </div>
              <span className={cn('text-xs', m.status === 'done' ? 'text-success' : m.status === 'dropped' ? 'text-faint' : 'text-muted')}>{STATUS_LABEL[m.status] ?? m.status}</span>
            </div>
            {!archived ? (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <label className="flex items-center gap-1">
                  <span className="text-muted">Status</span>
                  <select className="rounded border border-line bg-surface px-2 py-1" value={m.status} disabled={busy !== null} onChange={(e) => update(m.id, { status: e.target.value })}>
                    {Object.entries(STATUS_LABEL).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
                {m.status === 'done' ? (
                  <label className="flex items-center gap-1">
                    <span className="text-muted">Backed by evidence</span>
                    <select className="max-w-xs rounded border border-line bg-surface px-2 py-1" value={m.evidenceId ?? ''} disabled={busy !== null} onChange={(e) => update(m.id, { status: 'done', evidenceId: e.target.value || null })}>
                      <option value="">none stated</option>
                      {evidence.map((ev) => (
                        <option key={ev.id} value={ev.id}>
                          {ev.claim.length > 60 ? `${ev.claim.slice(0, 57)}…` : ev.claim}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {busy === m.id ? <Loader2 className="h-3 w-3 animate-spin text-muted" aria-label="Saving" /> : null}
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      {!archived ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className="btn-secondary" disabled={busy !== null} onClick={() => act('refresh')}>
            {busy === 'refresh' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Re-run as a new version
          </button>
          <button type="button" className="rounded-md border border-line px-3 py-2 text-sm text-muted" disabled={busy !== null} onClick={() => act('archive')}>
            Archive this plan
          </button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
