'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, MessagesSquare } from 'lucide-react';

export function InterviewPrepButton({
  applicationId,
  label = 'Yes, help me prepare',
}: {
  applicationId: string;
  label?: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/interview-prep', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ applicationId }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? 'Could not build your prep pack.');
        setLoading(false);
        return;
      }

      router.push(`/dashboard/interview-prep/${applicationId}`);
      router.refresh();
    } catch {
      setError('Could not reach the server.');
      setLoading(false);
    }
  }

  return (
    <div>
      <button onClick={generate} disabled={loading} className="btn-primary w-full">
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessagesSquare className="h-4 w-4" />}
        {loading ? 'Building your pack…' : label}
      </button>
      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
