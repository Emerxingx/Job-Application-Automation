'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Card, StatusBadge } from '@/components/ui';

export interface RequisitionRow {
  id: string;
  title: string;
  status: string;
  location: string;
  jobId: string | null;
  submissions: number;
  updatedAt: string;
}

/**
 * Stage 18 (ADR-0033): the organisation's requisitions. A requisition is a
 * draft until it is opened; opening publishes it as a first-party posting on
 * this platform through the connector gate - nothing is sent anywhere else.
 */
export function EmployerRequisitions({ organizationId, rows, canCreate }: { organizationId: string; rows: RequisitionRow[]; canCreate: boolean }) {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [location, setLocation] = useState('');
  const [skills, setSkills] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function call(key: string, url: string, method: string, body: unknown, after?: () => void) {
    setBusy(key);
    setMessage(null);
    try {
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ ok: false, text: data.error ?? 'The request failed.' });
        return;
      }
      after?.();
      router.refresh();
    } catch {
      setMessage({ ok: false, text: 'Could not reach the server.' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {canCreate ? (
        <Card className="p-5">
          <h2 className="text-base font-semibold text-ink">New requisition</h2>
          <p className="mt-1 text-xs text-muted">Saved as a draft. Opening it publishes a posting on this platform that candidates&rsquo; agents match like any other; candidates apply here, and their application is their consent to be seen by your organisation.</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              call('create', '/api/employer/requisitions', 'POST', { organizationId, title, location, description: description || undefined, requiredSkills: skills.split(',').map((s) => s.trim()).filter(Boolean) }, () => {
                setTitle('');
                setLocation('');
                setSkills('');
                setDescription('');
              });
            }}
            className="mt-3 grid gap-3 md:grid-cols-2"
          >
            <label className="flex flex-col text-sm">
              <span className="text-muted">Title</span>
              <input className="rounded-md border border-line bg-surface px-3 py-2" required minLength={2} value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label className="flex flex-col text-sm">
              <span className="text-muted">Location</span>
              <input className="rounded-md border border-line bg-surface px-3 py-2" required minLength={2} placeholder="Toronto, ON" value={location} onChange={(e) => setLocation(e.target.value)} />
            </label>
            <label className="flex flex-col text-sm md:col-span-2">
              <span className="text-muted">Required skills (comma-separated)</span>
              <input className="rounded-md border border-line bg-surface px-3 py-2" value={skills} onChange={(e) => setSkills(e.target.value)} />
            </label>
            <label className="flex flex-col text-sm md:col-span-2">
              <span className="text-muted">Description</span>
              <textarea className="rounded-md border border-line bg-surface px-3 py-2" rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
            <div className="md:col-span-2">
              <button type="submit" className="btn-primary" disabled={busy !== null}>
                {busy === 'create' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Save draft
              </button>
            </div>
          </form>
        </Card>
      ) : null}
      {message ? <p className={`text-sm ${message.ok ? 'text-success' : 'text-danger'}`}>{message.text}</p> : null}
      <Card className="p-0">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3">Requisition</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Pipeline</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-muted" colSpan={4}>
                  No requisitions yet.
                </td>
              </tr>
            ) : null}
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-line">
                <td className="px-4 py-3">
                  <Link href={`/dashboard/employer/${r.id}?org=${organizationId}`} className="font-medium text-ink hover:underline">
                    {r.title}
                  </Link>
                  <p className="text-xs text-muted">{r.location}</p>
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={r.status} />
                </td>
                <td className="px-4 py-3 text-muted">{r.submissions} candidate{r.submissions === 1 ? '' : 's'}</td>
                <td className="px-4 py-3 text-right">
                  {canCreate && r.status === 'draft' ? (
                    <button type="button" className="btn-secondary text-xs" disabled={busy !== null} onClick={() => call(r.id, `/api/employer/requisitions/${r.id}`, 'PATCH', { action: 'status', organizationId, status: 'open' })}>
                      Open and publish
                    </button>
                  ) : null}
                  {canCreate && r.status === 'open' ? (
                    <button type="button" className="rounded-md border border-line px-3 py-2 text-xs text-muted" disabled={busy !== null} onClick={() => call(r.id, `/api/employer/requisitions/${r.id}`, 'PATCH', { action: 'status', organizationId, status: 'on_hold' })}>
                      Put on hold
                    </button>
                  ) : null}
                  {canCreate && r.status === 'on_hold' ? (
                    <button type="button" className="btn-secondary text-xs" disabled={busy !== null} onClick={() => call(r.id, `/api/employer/requisitions/${r.id}`, 'PATCH', { action: 'status', organizationId, status: 'open' })}>
                      Reopen
                    </button>
                  ) : null}
                  {r.jobId ? (
                    <Link href={`/dashboard/jobs/${r.jobId}`} className="ml-2 text-xs text-muted underline">
                      posting
                    </Link>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
