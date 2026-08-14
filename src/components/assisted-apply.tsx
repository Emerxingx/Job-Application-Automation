'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Copy, ExternalLink, Loader2 } from 'lucide-react';
import { Card } from './ui';

export interface AssistedField {
  key: string;
  label: string;
  value: string;
  multiline?: boolean;
}

/**
 * The assisted-apply panel.
 *
 * Everything the employer's form asks for is already prepared; the applicant
 * copies each field and confirms. We deliberately do not mark the application
 * as submitted on their behalf — only their explicit confirmation does that,
 * so the tracker never overstates what happened.
 */
export function AssistedApply({
  applicationId,
  applyUrl,
  atsName,
  fields,
}: {
  applicationId: string;
  applyUrl: string;
  atsName?: string;
  fields: AssistedField[];
}) {
  const router = useRouter();
  const [copied, setCopied] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function copy(field: AssistedField) {
    try {
      await navigator.clipboard.writeText(field.value);
      setCopied(field.key);
      setTimeout(() => setCopied((c) => (c === field.key ? null : c)), 1600);
    } catch {
      setError('Your browser blocked the clipboard. Select the text and copy it manually.');
    }
  }

  async function confirm() {
    setConfirming(true);
    setError(null);
    try {
      const res = await fetch(`/api/applications/${applicationId}/confirm`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.error ?? 'That could not be saved. Try again.');
        return;
      }
      router.refresh();
    } catch {
      setError('That could not be saved. Check your connection and try again.');
    } finally {
      setConfirming(false);
    }
  }

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-ink">Ready to send</h2>
          <p className="mt-1 max-w-prose text-sm text-muted">
            Your tailored resume and cover letter are prepared. Open the employer&rsquo;s form
            {atsName ? ` on ${atsName}` : ''}, paste each field, and submit — usually under a minute.
          </p>
        </div>
        <a
          href={applyUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-primary inline-flex shrink-0 items-center whitespace-nowrap"
        >
          Open the form
          <ExternalLink className="ml-1.5 h-4 w-4" />
        </a>
      </div>

      <ul className="mt-4 divide-y divide-line rounded-lg border border-line">
        {fields.map((field) => (
          <li key={field.key} className="flex items-start gap-3 p-3">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium uppercase tracking-wide text-muted">{field.label}</p>
              {field.multiline ? (
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-2 p-2 font-mono text-xs text-ink">
                  {field.value}
                </pre>
              ) : (
                <p className="mt-0.5 break-words text-sm text-ink">{field.value}</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => copy(field)}
              aria-label={`Copy ${field.label}`}
              className="mt-0.5 flex shrink-0 items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs font-medium text-muted transition hover:border-brand-500 hover:text-brand-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
            >
              {copied === field.key ? (
                <>
                  <Check className="h-3.5 w-3.5 text-success" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  Copy
                </>
              )}
            </button>
          </li>
        ))}
      </ul>

      {error && <p className="mt-3 text-sm text-danger">{error}</p>}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={confirm}
          disabled={confirming}
          className="btn-primary inline-flex items-center disabled:opacity-60"
        >
          {confirming && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
          I submitted this application
        </button>
        <p className="text-xs text-muted">
          This marks the application as submitted in your tracker.
        </p>
      </div>
    </Card>
  );
}
