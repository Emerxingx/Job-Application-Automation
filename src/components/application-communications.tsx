'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarDays, Check, Loader2, Mail, X } from 'lucide-react';
import { Card, cn } from '@/components/ui';

/**
 * Stage 11 — the folder's communications: threads and calendar events filed
 * here (automatically above the threshold, or confirmed by the applicant),
 * and suggestions the engine was not sure about, which the applicant
 * confirms or rejects. Subjects and participants only; no body exists.
 */
export interface ThreadView {
  id: string;
  subject: string;
  from: string;
  lastLabel: string;
  confidence: number;
  status: string;
  signals: string[];
  interview: boolean;
  offer: boolean;
}
export interface EventView {
  id: string;
  title: string;
  organiser: string;
  whenLabel: string;
  confidence: number;
  status: string;
}

export function ApplicationCommunications({ applicationId, threads, suggestions, events, eventSuggestions }: { applicationId: string; threads: ThreadView[]; suggestions: ThreadView[]; events: EventView[]; eventSuggestions: EventView[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(kind: 'threads' | 'events', id: string, decision: 'confirm' | 'reject') {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/mailbox/${kind}/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision, applicationId: decision === 'confirm' ? applicationId : null }) });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? 'The change was refused.');
        return;
      }
      router.refresh();
    } catch {
      setError('The request could not be sent.');
    } finally {
      setBusy(null);
    }
  }

  if (threads.length === 0 && suggestions.length === 0 && events.length === 0 && eventSuggestions.length === 0) return null;
  return (
    <Card className="p-5">
      <h2 className="mb-1 flex items-center gap-2 font-semibold text-ink">
        <Mail className="h-4 w-4 text-faint" aria-hidden="true" />
        Communications
      </h2>
      <p className="mb-3 text-xs text-muted">Headers only — sender, subject, date. JobPilot never reads or sends a message.</p>
      <p role="status" aria-live="polite" className="m-0 text-xs text-danger">
        {error}
      </p>
      {(suggestions.length > 0 || eventSuggestions.length > 0) && (
        <div className="mb-4 rounded-xl border border-warn/40 bg-warn/5 p-3">
          <p className="mb-2 text-xs font-medium text-ink">Is this about this application? These were not filed automatically.</p>
          <ul className="space-y-2">
            {suggestions.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-ink">{t.subject || '(no subject)'}</span>
                  <span className="block truncate text-xs text-faint">
                    {t.from} · {t.lastLabel} · {Math.round(t.confidence * 100)}% ({t.signals.join(', ') || 'no signal'})
                  </span>
                </span>
                <button type="button" className="btn-secondary px-2.5 py-1 text-xs" disabled={busy !== null} onClick={() => decide('threads', t.id, 'confirm')}>
                  {busy === t.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Check className="h-3.5 w-3.5" aria-hidden="true" />} Yes, file it
                </button>
                <button type="button" className="btn-ghost px-2.5 py-1 text-xs" disabled={busy !== null} onClick={() => decide('threads', t.id, 'reject')}>
                  <X className="h-3.5 w-3.5" aria-hidden="true" /> No
                </button>
              </li>
            ))}
            {eventSuggestions.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-2 text-sm">
                <CalendarDays className="h-4 w-4 shrink-0 text-faint" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-ink">{e.title || '(untitled event)'}</span>
                  <span className="block truncate text-xs text-faint">
                    {e.whenLabel} · {e.organiser} · {Math.round(e.confidence * 100)}%
                  </span>
                </span>
                <button type="button" className="btn-secondary px-2.5 py-1 text-xs" disabled={busy !== null} onClick={() => decide('events', e.id, 'confirm')}>
                  {busy === e.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Check className="h-3.5 w-3.5" aria-hidden="true" />} Yes, file it
                </button>
                <button type="button" className="btn-ghost px-2.5 py-1 text-xs" disabled={busy !== null} onClick={() => decide('events', e.id, 'reject')}>
                  <X className="h-3.5 w-3.5" aria-hidden="true" /> No
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {threads.length > 0 && (
        <ul className="divide-y divide-line text-sm">
          {threads.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-2 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-ink">{t.subject || '(no subject)'}</span>
                <span className="block truncate text-xs text-faint">
                  {t.from} · {t.lastLabel} · {t.status === 'confirmed' ? 'filed by you' : `filed automatically (${Math.round(t.confidence * 100)}%)`}
                </span>
              </span>
              {t.interview && <span className="chip bg-brand-500/10 text-brand-600">interview</span>}
              {t.offer && <span className="chip bg-success/10 text-success">offer</span>}
              <button type="button" className="btn-ghost px-2 py-1 text-xs" disabled={busy !== null} onClick={() => decide('threads', t.id, 'reject')} title="Not about this application">
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {events.length > 0 && (
        <ul className={cn('divide-y divide-line text-sm', threads.length > 0 ? 'mt-3 border-t border-line pt-2' : '')}>
          {events.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-2 py-2">
              <CalendarDays className="h-4 w-4 shrink-0 text-faint" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-ink">{e.title || '(untitled event)'}</span>
                <span className="block truncate text-xs text-faint">
                  {e.whenLabel} · {e.organiser} · {e.status === 'confirmed' ? 'filed by you' : `filed automatically (${Math.round(e.confidence * 100)}%)`}
                </span>
              </span>
              <button type="button" className="btn-ghost px-2 py-1 text-xs" disabled={busy !== null} onClick={() => decide('events', e.id, 'reject')} title="Not about this application">
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
