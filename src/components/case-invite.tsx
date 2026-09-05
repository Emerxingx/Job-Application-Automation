'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Card } from '@/components/ui';

/** Stage 17: a supervisor or admin invites a client by the email the client gave them. The case holds nothing until the client accepts. */
export function CaseInvite({ organizationId, members }: { organizationId: string; members: { userId: string; label: string }[] }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [caseManagerId, setCaseManagerId] = useState('');
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/cases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ organizationId, email, caseManagerId: caseManagerId || null, employmentGoal: goal || undefined }) });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ ok: false, text: data.error ?? 'Could not invite the client.' });
        return;
      }
      setMessage({ ok: true, text: 'Invitation recorded for that address. If the client has an account with it - or signs up with it - the invitation appears under their Settings; until they accept, the case holds nothing about them.' });
      setEmail('');
      setGoal('');
      router.refresh();
    } catch {
      setMessage({ ok: false, text: 'Could not reach the server.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold text-ink">Invite a client</h2>
      <p className="mt-1 text-xs text-muted">Use the email the client gave you for this purpose. The invitation is addressed to that email; the platform does not tell you whether an account exists. Nothing about the client is visible until they accept and consent.</p>
      <form onSubmit={submit} className="mt-3 grid gap-3 md:grid-cols-2">
        <label className="flex flex-col text-sm">
          <span className="text-muted">Client email</span>
          <input className="rounded-md border border-line bg-surface px-3 py-2" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="flex flex-col text-sm">
          <span className="text-muted">Case manager</span>
          <select className="rounded-md border border-line bg-surface px-3 py-2" value={caseManagerId} onChange={(e) => setCaseManagerId(e.target.value)}>
            <option value="">Unassigned</option>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-sm md:col-span-2">
          <span className="text-muted">Employment goal (optional)</span>
          <input className="rounded-md border border-line bg-surface px-3 py-2" value={goal} maxLength={500} onChange={(e) => setGoal(e.target.value)} />
        </label>
        <div className="md:col-span-2">
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Send invitation
          </button>
        </div>
      </form>
      {message ? (
        <p role={message.ok ? 'status' : 'alert'} className={`mt-2 text-sm ${message.ok ? 'text-success' : 'text-danger'}`}>
          {message.text}
        </p>
      ) : null}
    </Card>
  );
}
