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

/** Stage 12: a question-bank entry as prepared — `never` carries no value. */
export interface AssistedQuestion {
  id: string;
  question: string;
  category: string;
  policy: string;
  decision: 'fill' | 'ask' | 'review' | 'never';
  value: string;
  canonicalKey: string | null;
}

const DECISION_COPY: Record<AssistedQuestion['decision'], { label: string; hint: string; tone: string }> = {
  fill: { label: 'Ready', hint: 'Your stored answer, ready to copy.', tone: 'bg-success/10 text-success' },
  ask: { label: 'Confirm first', hint: 'Check this is still current before you use it.', tone: 'bg-warn/10 text-warn' },
  review: { label: 'Review', hint: 'Read this before you use it; it may need updating.', tone: 'bg-brand-500/10 text-brand-600' },
  never: { label: 'Answer yourself', hint: 'JobPilot never prepares this — a person answers it on the form.', tone: 'bg-raised text-muted' },
};

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
  questions = [],
  atsSubmittable = false,
  mode = 'review_submit',
  mappingVersion,
}: {
  applicationId: string;
  applyUrl: string;
  atsName?: string;
  fields: AssistedField[];
  questions?: AssistedQuestion[];
  /** Stage 12: the employer has authorised a programmatic submission and the mode permits it. */
  atsSubmittable?: boolean;
  mode?: string;
  mappingVersion?: string;
}) {
  const router = useRouter();
  const [copied, setCopied] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitViaAts() {
    if (!window.confirm(`Submit this application through ${atsName ?? 'the employer’s system'} now? You have reviewed it; JobPilot sends exactly what is shown here.`)) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/applications/${applicationId}/submit`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.error ?? 'That could not be submitted. You can still use the employer’s form.');
        return;
      }
      router.refresh();
    } catch {
      setError('That could not be submitted. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  async function copyText(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1600);
    } catch {
      setError('Your browser blocked the clipboard. Select the text and copy it manually.');
    }
  }

  async function copy(field: AssistedField) {
    await copyText(field.key, field.value);
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

      {questions.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Questions this form may ask</p>
          <p className="mt-0.5 text-xs text-faint">
            From your question bank, each under its own policy{mappingVersion ? ` (mapping register ${mappingVersion})` : ''}. Anything marked “Answer yourself” is never prepared, in any mode.
          </p>
          <ul className="mt-2 divide-y divide-line rounded-lg border border-line">
            {questions.map((q) => {
              const copy = DECISION_COPY[q.decision] ?? DECISION_COPY.review;
              return (
                <li key={q.id} className="flex items-start gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink">{q.question}</p>
                    {q.decision !== 'never' && q.value ? <p className="mt-0.5 break-words text-sm text-ink">{q.value}</p> : <p className="mt-0.5 text-xs text-faint">{q.decision === 'never' ? copy.hint : 'No stored answer — you answer this on the form.'}</p>}
                    <span className={`chip mt-1 ${copy.tone}`} title={copy.hint}>
                      {copy.label}
                    </span>
                  </div>
                  {q.decision !== 'never' && q.value && (
                    <button
                      type="button"
                      onClick={() => copyText(`q:${q.id}`, q.value)}
                      aria-label={`Copy answer to ${q.question}`}
                      className="mt-0.5 flex shrink-0 items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs font-medium text-muted transition hover:border-brand-500 hover:text-brand-600"
                    >
                      {copied === `q:${q.id}` ? <><Check className="h-3.5 w-3.5 text-success" />Copied</> : <><Copy className="h-3.5 w-3.5" />Copy</>}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-danger">{error}</p>}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {atsSubmittable && mode === 'review_submit' && (
          <button type="button" onClick={submitViaAts} disabled={submitting || confirming} className="btn-primary inline-flex items-center disabled:opacity-60">
            {submitting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Submit through {atsName ?? 'the employer’s system'}
          </button>
        )}
        <button
          type="button"
          onClick={confirm}
          disabled={confirming || submitting}
          className={`${atsSubmittable && mode === 'review_submit' ? 'btn-secondary' : 'btn-primary'} inline-flex items-center disabled:opacity-60`}
        >
          {confirming && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
          I submitted this on the employer’s form
        </button>
        <p className="text-xs text-muted">
          {atsSubmittable && mode === 'review_submit'
            ? 'This employer has authorised JobPilot to submit through their system — only when you say so, after your review. Or confirm that you sent it yourself.'
            : 'Nothing is sent by JobPilot. This marks the application as submitted in your tracker.'}
        </p>
      </div>
    </Card>
  );
}
