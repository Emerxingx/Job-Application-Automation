'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Sparkles } from 'lucide-react';

export function ApplyOneButton({ jobId, disabled }: { jobId: string; disabled?: boolean }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply() {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobIds: [jobId] }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? 'Could not submit the application.');
        setLoading(false);
        return;
      }

      const outcome = data.outcomes?.[0];
      if (outcome?.applicationId) {
        router.push(`/dashboard/applications/${outcome.applicationId}`);
      } else {
        setError(outcome?.reason ?? 'The application could not be submitted.');
        setLoading(false);
        return;
      }
      router.refresh();
    } catch {
      setError('Could not reach the server.');
      setLoading(false);
    }
  }

  return (
    <div>
      <button onClick={apply} disabled={loading || disabled} className="btn-primary w-full">
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
        {loading ? 'Tailoring and applying…' : 'Apply with tailored resume'}
      </button>
      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
