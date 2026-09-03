'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, PenLine } from 'lucide-react';
import { Card } from '@/components/ui';
import { KIND_LABELS, MESSAGE_HINTS, MESSAGE_KINDS, type MessageKind } from '@/lib/documents/kinds';

export interface ExistingMessageView {
  id: string;
  kind: string;
  version: number;
  createdLabel: string;
}

/**
 * Stage 09: draft a message about this application — application note,
 * recruiter introduction, outreach, follow-up, thank-you. Each draft is a
 * versioned document; the applicant copies it and sends it themselves.
 * Nothing here sends anything.
 */
export function ApplicationMessages({ applicationId, existing }: { applicationId: string; existing: ExistingMessageView[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<MessageKind | null>(null);
  const [draft, setDraft] = useState<{ kind: MessageKind; text: string; version: number; route: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function compose(kind: MessageKind) {
    setBusy(kind);
    setError(null);
    try {
      const res = await fetch(`/api/applications/${applicationId}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind }) });
      const data = (await res.json()) as { error?: string; text?: string; document?: { version: number }; route?: string };
      if (!res.ok || !data.text) {
        setError(data.error ?? 'The message could not be drafted.');
        return;
      }
      setDraft({ kind, text: data.text, version: data.document?.version ?? 1, route: data.route ?? 'deterministic' });
      router.refresh();
    } catch {
      setError('The request could not be sent.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="p-5">
      <h2 className="mb-1 font-semibold text-ink">Messages</h2>
      <p className="mb-4 text-sm text-muted">
        Drafted only from your resume and approved evidence — no employer, date or metric is ever invented. Copy, edit, and send it yourself; JobPilot never contacts anyone on your behalf.
      </p>
      <div className="flex flex-wrap gap-2">
        {MESSAGE_KINDS.map((kind) => (
          <button key={kind} type="button" className="btn-secondary px-3 py-1.5 text-xs" disabled={busy !== null} title={MESSAGE_HINTS[kind]} onClick={() => compose(kind)}>
            {busy === kind ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <PenLine className="h-3.5 w-3.5" aria-hidden="true" />}
            {KIND_LABELS[kind]}
          </button>
        ))}
      </div>
      <p role="status" aria-live="polite" className="m-0 mt-2 text-xs text-danger">
        {error}
      </p>
      {draft && (
        <div className="mt-4">
          <p className="mb-2 text-xs text-faint">
            {KIND_LABELS[draft.kind]} · saved as v{draft.version} · {draft.route === 'external' ? 'model-assisted, grounded' : 'deterministic'}
          </p>
          <div className="scroll-x max-h-96 overflow-y-auto rounded-xl bg-raised p-4">
            <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-muted">{draft.text}</pre>
          </div>
        </div>
      )}
      {existing.length > 0 && (
        <ul className="mt-4 space-y-1 border-t border-line pt-3 text-xs text-muted">
          {existing.map((m) => (
            <li key={m.id}>
              <a href={`/api/documents/${m.id}`} className="font-medium text-ink hover:underline">
                {KIND_LABELS[m.kind as MessageKind] ?? m.kind} v{m.version}
              </a>{' '}
              · {m.createdLabel}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
