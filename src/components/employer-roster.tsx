'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui';

/** Stage 18: an administrator sets each member's hiring role (a named set over the organisation ladder; unknown is viewer). */
export function EmployerRoster({ organizationId, members }: { organizationId: string; members: { userId: string; label: string; role: string; serviceRole: string | null }[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function setRole(userId: string, serviceRole: string) {
    setBusy(userId);
    setError(null);
    try {
      const res = await fetch('/api/employer/roster', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ organizationId, userId, serviceRole: serviceRole || null }) });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? 'Could not set the role.');
      else router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(null);
    }
  }
  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold text-ink">Hiring team</h2>
      <p className="mt-1 text-xs text-muted">Owners and administrators act as admin. Recruiters source and ask for disclosure; a hiring manager owns their requisitions; interviewers record their interviews; anyone else reads.</p>
      {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
      <ul className="mt-3 divide-y divide-line text-sm">
        {members.map((m) => (
          <li key={m.userId} className="flex items-center justify-between gap-3 py-2">
            <span className="text-ink">{m.label}</span>
            {m.role === 'owner' || m.role === 'admin' ? (
              <span className="text-xs text-muted">admin</span>
            ) : (
              <select className="rounded-md border border-line bg-surface px-2 py-1 text-xs" value={m.serviceRole ?? ''} disabled={busy !== null} onChange={(e) => setRole(m.userId, e.target.value)}>
                <option value="">viewer</option>
                <option value="recruiter">recruiter</option>
                <option value="hiring_manager">hiring manager</option>
                <option value="interviewer">interviewer</option>
              </select>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
