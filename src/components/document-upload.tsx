'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, ShieldCheck, Upload } from 'lucide-react';
import { Card } from '@/components/ui';

const REASONS: Record<string, string> = {
  empty: 'The file is empty.',
  too_large: 'The file is larger than 5 MB.',
  unrecognised_type: 'Only PDF, DOCX and plain-text files are accepted.',
  extension_mismatch: 'The file name does not match what the file actually is.',
  pdf_active_content: 'The PDF carries scripts or actions, which a resume never needs.',
  not_docx: 'The archive is not a Word document.',
  docx_macros: 'The document carries macros.',
  docx_external_reference: 'The document references external objects.',
  zip_bomb: 'The document would expand to an unreasonable size.',
  zip_too_many_entries: 'The document archive has too many entries.',
  zip_path_traversal: 'The document archive is malformed.',
  zip_unreadable: 'The document archive could not be read.',
};

/** Stage 09: upload an existing résumé. Scanned server-side before it is stored; refused files never are. */
export function DocumentUpload() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function upload(file: File) {
    setBusy(true);
    setMessage(null);
    try {
      const body = new FormData();
      body.append('file', file);
      const res = await fetch('/api/documents/upload', { method: 'POST', body });
      const data = (await res.json()) as { error?: string; reasons?: string[]; document?: { version: number; format: string } };
      if (!res.ok) {
        const why = (data.reasons ?? []).map((r) => REASONS[r] ?? r).join(' ');
        setMessage({ ok: false, text: `${data.error ?? 'The file was refused.'} ${why}`.trim() });
      } else {
        setMessage({ ok: true, text: `Stored as ${data.document?.format.toUpperCase()} v${data.document?.version} after the scan.` });
        router.refresh();
      }
    } catch {
      setMessage({ ok: false, text: 'The upload could not be sent.' });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  return (
    <Card className="mb-6 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-ink">Upload a resume</h2>
          <p className="mt-1 text-sm text-muted">
            PDF, DOCX or plain text, up to 5 MB. Every upload is scanned on the server before it is stored — scripts, macros and mismatched types are refused.
          </p>
        </div>
        <label className="btn-secondary cursor-pointer">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Upload className="h-4 w-4" aria-hidden="true" />}
          Choose file
          <input ref={input} type="file" accept=".pdf,.docx,.txt,.md" className="sr-only" disabled={busy} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        </label>
      </div>
      <p role="status" aria-live="polite" className={`m-0 mt-2 text-xs ${message?.ok ? 'text-success' : 'text-danger'}`}>
        {message?.ok && <ShieldCheck className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />}
        {message?.text}
      </p>
    </Card>
  );
}
