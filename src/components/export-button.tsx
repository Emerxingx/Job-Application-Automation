'use client';

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { AlertCircle, ChevronDown, Download, FileSpreadsheet, FileText, Loader2 } from 'lucide-react';
import { cn } from '@/components/ui';

export type ExportFormat = 'csv' | 'pdf';

const FORMAT_META: Record<ExportFormat, { label: string; hint: string; extension: string }> = {
  csv: { label: 'CSV', hint: 'Every row, for a spreadsheet', extension: 'csv' },
  pdf: { label: 'PDF', hint: 'Formatted, for sharing', extension: 'pdf' },
};

export interface ExportButtonProps {
  /**
   * Endpoint that returns the file. The chosen format is appended as a
   * `format` query parameter, so one route serves both:
   * `/api/console/invoices/export?format=csv`.
   */
  endpoint: string;
  /** Base filename, no extension. Falls back to `export`. */
  filename?: string;
  /** Extra query parameters — the active filters. `null`/`undefined` are dropped. */
  params?: Record<string, string | number | boolean | null | undefined>;
  /** Formats to offer, in order. Defaults to CSV then PDF. */
  formats?: readonly ExportFormat[];
  /** Use POST when the filter set is too large for a URL. `params` still apply. */
  method?: 'GET' | 'POST';
  /** JSON body for a POST export. */
  body?: unknown;
  label?: string;
  /** Called instead of the inline banner when you want to own error display. */
  onError?: (message: string) => void;
  /** Called once the browser has been handed the file. */
  onSuccess?: (format: ExportFormat) => void;
  disabled?: boolean;
  className?: string;
}

/** Pull the server's filename out of `Content-Disposition`, if it set one. */
function filenameFromHeaders(headers: Headers): string | null {
  const disposition = headers.get('Content-Disposition');
  if (!disposition) return null;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1]);
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  return plain ? plain[1] : null;
}

/**
 * Download menu for a report or table view.
 *
 * The request carries the page's current filters, so what lands in the file is
 * what the reader is looking at — never the unfiltered table. Failures surface
 * in place with the server's own message (routes built on `fail()` return
 * `{ error }`), because a silent no-op on an export button reads as a broken
 * page.
 *
 * ```tsx
 * <ExportButton
 *   endpoint="/api/console/revenue/export"
 *   filename="revenue"
 *   params={{ ...toRangeParams(range), currency }}
 * />
 * ```
 */
export function ExportButton({
  endpoint,
  filename = 'export',
  params,
  formats = ['csv', 'pdf'],
  method = 'GET',
  body,
  label = 'Export',
  onError,
  onSuccess,
  disabled,
  className,
}: ExportButtonProps) {
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (open) requestAnimationFrame(() => itemRefs.current[0]?.focus());
  }, [open]);

  const run = useCallback(
    async (format: ExportFormat) => {
      setOpen(false);
      setBusy(format);
      setError(null);

      try {
        const url = new URL(endpoint, window.location.origin);
        url.searchParams.set('format', format);
        for (const [key, value] of Object.entries(params ?? {})) {
          if (value === null || value === undefined || value === '') continue;
          url.searchParams.set(key, String(value));
        }

        const response = await fetch(url, {
          method,
          headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
          body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
        });

        if (!response.ok) {
          let message = `The export failed (${response.status}).`;
          try {
            const payload = (await response.json()) as { error?: string };
            if (payload?.error) message = payload.error;
          } catch {
            /* the body was not JSON — keep the status message */
          }
          setError(message);
          onError?.(message);
          return;
        }

        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download =
          filenameFromHeaders(response.headers) ??
          `${filename}-${new Date().toISOString().slice(0, 10)}.${FORMAT_META[format].extension}`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        // Revoking immediately can cancel the download in Safari; one turn of
        // the event loop is enough for the navigation to have been taken.
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
        onSuccess?.(format);
      } catch {
        const message = 'Could not reach the server. Please try again.';
        setError(message);
        onError?.(message);
      } finally {
        setBusy(null);
      }
    },
    [endpoint, params, method, body, filename, onError, onSuccess],
  );

  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    const last = formats.length - 1;
    let next: number | null = null;
    if (event.key === 'ArrowDown') next = index === last ? 0 : index + 1;
    else if (event.key === 'ArrowUp') next = index === 0 ? last : index - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    else if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (next === null) return;
    event.preventDefault();
    itemRefs.current[next]?.focus();
  }

  const single = formats.length === 1;

  return (
    <div className={cn('relative', className)} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled || busy !== null}
        aria-haspopup={single ? undefined : 'menu'}
        aria-expanded={single ? undefined : open}
        aria-controls={single || !open ? undefined : menuId}
        onClick={() => (single ? void run(formats[0]) : setOpen((value) => !value))}
        className="btn-secondary px-3 py-2 text-xs"
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        ) : (
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        {busy ? `Preparing ${FORMAT_META[busy].label}…` : label}
        {!single && (
          <ChevronDown
            className={cn(
              'h-3.5 w-3.5 transition-transform duration-150 motion-reduce:transition-none',
              open && 'rotate-180',
            )}
            aria-hidden="true"
          />
        )}
      </button>

      {open && !single && (
        <div
          id={menuId}
          role="menu"
          aria-label={`${label} format`}
          className="card absolute right-0 z-30 mt-1 w-60 overflow-hidden p-1 shadow-lift"
        >
          {formats.map((format, index) => {
            const meta = FORMAT_META[format];
            const Icon = format === 'csv' ? FileSpreadsheet : FileText;
            return (
              <button
                key={format}
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
                type="button"
                role="menuitem"
                onClick={() => void run(format)}
                onKeyDown={(event) => onMenuKeyDown(event, index)}
                className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left
                           transition-colors duration-150 hover:bg-raised motion-reduce:transition-none"
              >
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-ink">{meta.label}</span>
                  <span className="block text-xs text-muted">{meta.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="absolute right-0 top-full z-30 mt-1 flex w-64 items-start gap-1.5 rounded-xl
                     bg-danger/10 p-2.5 text-xs text-danger shadow-card"
        >
          <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
