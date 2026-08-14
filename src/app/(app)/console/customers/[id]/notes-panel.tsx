'use client';

import { useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, Loader2, Pin, StickyNote } from 'lucide-react';
import { cn } from '@/components/ui';

export interface NoteView {
  id: string;
  staffName: string;
  body: string;
  pinned: boolean;
  createdLabel: string;
}

/**
 * Staff notes, with the composer inline above them.
 *
 * The note is written through the existing POST
 * /api/console/customers/:id/notes, which is what appends the matching
 * immutable CrmActivity entry — posting straight to Prisma from here would
 * create a note with no timeline record of it having been written.
 *
 * `router.refresh()` on success re-runs the server component, so the new note
 * arrives with the same shape and ordering (pinned first) as every other note,
 * rather than being spliced into local state and disagreeing with the server
 * on the next navigation.
 */
export function NotesPanel({
  userId,
  notes,
  authorName,
}: {
  userId: string;
  notes: NoteView[];
  authorName: string;
}) {
  const router = useRouter();
  const [body, setBody] = useState('');
  const [pinned, setPinned] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [refreshing, startTransition] = useTransition();

  const busy = saving || refreshing;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = body.trim();
    if (!text || busy) return;

    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/console/customers/${userId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: text, pinned }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(payload?.error ?? `The note could not be saved (${response.status}).`);
        return;
      }

      setBody('');
      setPinned(false);
      startTransition(() => router.refresh());
    } catch {
      setError('Could not reach the server. The note has not been saved — copy it before retrying.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <StickyNote className="h-4 w-4 text-muted" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-ink">Staff notes</h3>
        <span className="ml-auto text-xs text-faint">{notes.length}</span>
      </div>

      <form onSubmit={submit} className="border-b border-line p-4">
        <label htmlFor="note-body" className="label text-xs">
          Add a note as {authorName}
        </label>
        <textarea
          id="note-body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={3}
          maxLength={4000}
          disabled={busy}
          placeholder="What should the next person to open this account know?"
          className="input resize-y disabled:opacity-60"
        />

        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={pinned}
              onChange={(event) => setPinned(event.target.checked)}
              disabled={busy}
              className="h-3.5 w-3.5 rounded border-line accent-brand-500"
            />
            <Pin className="h-3.5 w-3.5" aria-hidden="true" />
            Pin to the top
          </label>

          <button
            type="submit"
            disabled={busy || body.trim().length === 0}
            className="btn-primary px-3 py-2 text-xs"
          >
            {busy && (
              <Loader2
                className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            )}
            {saving ? 'Saving…' : 'Add note'}
          </button>
        </div>

        {error && (
          <p
            role="alert"
            className="mt-2 flex items-start gap-1.5 rounded-xl bg-danger/10 p-2.5 text-xs text-danger"
          >
            <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {error}
          </p>
        )}
      </form>

      {notes.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted">
          No notes yet. The first one is usually the most useful.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {notes.map((note) => (
            <li key={note.id} className={cn('p-4', note.pinned && 'bg-warn/5')}>
              <div className="flex items-baseline justify-between gap-2">
                <p className="flex items-center gap-1.5 text-xs font-semibold text-ink">
                  {note.pinned && (
                    <Pin className="h-3 w-3 shrink-0 text-warn" aria-label="Pinned" />
                  )}
                  {note.staffName}
                </p>
                <p className="shrink-0 text-xs text-faint">{note.createdLabel}</p>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-sm text-muted">{note.body}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
