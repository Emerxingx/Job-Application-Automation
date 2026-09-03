'use client';

import { useState } from 'react';
import { CheckCircle2, Download, Link2, Lock, TriangleAlert } from 'lucide-react';
import { Card, cn } from '@/components/ui';

export interface DocumentVersionView {
  id: string;
  kind: string;
  label: string;
  format: string;
  version: number;
  status: string;
  sizeBytes: number;
  contentHash: string;
  /** null when no ATS report was recorded (an upload). */
  atsOk: boolean | null;
  createdLabel: string;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 104857.6) / 10} MB`;
}

/**
 * Stage 09: the versioned files of an application. Every download goes
 * through a signed, expiring link; "Copy link" mints one for another device.
 */
export function ApplicationDocuments({ documents, sealed }: { documents: DocumentVersionView[]; sealed: boolean }) {
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function copyLink(id: string) {
    setError(null);
    try {
      const res = await fetch(`/api/documents/${id}?link=1`);
      if (!res.ok) throw new Error('refused');
      const data = (await res.json()) as { url: string };
      const url = `${window.location.origin}${data.url}`;
      try {
        await navigator.clipboard.writeText(url);
        setCopied(id);
        setTimeout(() => setCopied(null), 2500);
      } catch {
        window.prompt('Copy this link (it works for 10 minutes):', url);
      }
    } catch {
      setError('A link could not be made for that file.');
    }
  }

  if (documents.length === 0) return null;
  return (
    <Card className="p-5">
      <h2 className="mb-1 font-semibold text-ink">Files</h2>
      <p className="mb-4 text-sm text-muted">
        {sealed
          ? 'Sealed at submission: these bytes cannot change, and each download is checked against its recorded hash.'
          : 'Ready to send. They are sealed the moment you confirm the application.'}
      </p>
      <p role="status" aria-live="polite" className="m-0 text-xs text-danger">
        {error}
      </p>
      <ul className="divide-y divide-line">
        {documents.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center gap-3 py-2.5">
            <span className={cn('chip shrink-0 font-mono text-[10px]', d.format === 'pdf' ? 'bg-danger/10 text-danger' : d.format === 'docx' ? 'bg-brand-500/10 text-brand-600' : 'bg-raised text-muted')}>
              {d.format.toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-ink">
                {d.label} · v{d.version}
                {d.status === 'submitted' && <Lock className="ml-1 inline h-3 w-3 text-faint" aria-label="sealed" />}
              </p>
              <p className="truncate font-mono text-[11px] text-faint">
                {size(d.sizeBytes)} · sha256 {d.contentHash.slice(0, 16)}… · {d.createdLabel}
                {d.atsOk === true && (
                  <span className="ml-1 text-success">
                    <CheckCircle2 className="inline h-3 w-3" aria-hidden="true" /> ATS checks passed
                  </span>
                )}
                {d.atsOk === false && (
                  <span className="ml-1 text-warn">
                    <TriangleAlert className="inline h-3 w-3" aria-hidden="true" /> ATS check flagged
                  </span>
                )}
              </p>
            </div>
            <button type="button" className="btn-ghost shrink-0 px-2.5 py-1.5 text-xs" onClick={() => copyLink(d.id)}>
              <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
              {copied === d.id ? 'Copied' : 'Copy link'}
            </button>
            <a href={`/api/documents/${d.id}`} className="btn-ghost shrink-0 px-2.5 py-1.5 text-xs">
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              Download
            </a>
          </li>
        ))}
      </ul>
    </Card>
  );
}
