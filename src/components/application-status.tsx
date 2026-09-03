'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

const OPTIONS = [
  { value: 'submitted', label: 'Submitted' },
  { value: 'interviewing', label: 'Interviewing' },
  { value: 'offer', label: 'Offer received' },
  { value: 'rejected', label: 'Not selected' },
  { value: 'withdrawn', label: 'Withdrawn' },
];

/** Lets the applicant record what happened after they applied. */
export function ApplicationStatusControl({
  applicationId,
  status,
}: {
  applicationId: string;
  status: string;
}) {
  const router = useRouter();
  const [value, setValue] = useState(status);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stage 10: the move goes through the status machine; a refusal comes
  // back with its reason and the control returns to the real status.
  async function update(next: string) {
    setValue(next);
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/applications/${applicationId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? 'That change was refused.');
        setValue(status);
        return;
      }
      router.refresh();
    } catch {
      setError('The request could not be sent.');
      setValue(status);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <label htmlFor="status" className="text-sm text-muted">
        Outcome
      </label>
      <select
        id="status"
        value={value}
        onChange={(e) => update(e.target.value)}
        disabled={saving}
        className="input w-auto py-1.5 text-sm"
      >
        {OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {saving && <Loader2 className="h-4 w-4 animate-spin text-muted" />}
      <span role="status" aria-live="polite" className="text-xs text-danger">
        {error}
      </span>
    </div>
  );
}
