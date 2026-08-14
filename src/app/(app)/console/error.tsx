'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { RefreshCw, ServerCrash } from 'lucide-react';

/**
 * The console's error boundary.
 *
 * It covers every page in the section, so it has to work for a failed query, a
 * malformed date in a query string and a report that timed out alike. Two rules
 * shape it:
 *
 *  1. It never shows `error.message` in production. In a development build the
 *     message is the fastest route to the bug; in production the message can
 *     carry a table name, a customer id or a connection string, and the digest
 *     is what correlates the screen with the server log.
 *  2. It offers `reset()` first. Most failures here are a transient database
 *     hiccup during a heavy report, and re-running the segment fixes them
 *     without losing the reader's place.
 */
export default function ConsoleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[console] render failed:', error);
  }, [error]);

  const showDetail = process.env.NODE_ENV !== 'production';

  return (
    <div className="mx-auto max-w-lg py-16">
      <div className="card p-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-danger/10">
          <ServerCrash className="h-6 w-6 text-danger" aria-hidden="true" />
        </div>
        <h1 className="text-xl font-bold text-ink">This console page could not be loaded</h1>
        <p className="mt-2 text-sm text-muted">
          Nothing was changed. Try again — if it keeps failing, the reference below identifies this
          exact failure in the server log.
        </p>

        {showDetail && (
          <pre className="scroll-x mt-4 rounded-xl bg-raised p-3 text-left text-xs text-muted">
            {error.message}
          </pre>
        )}
        {error.digest && (
          <p className="mt-3 text-xs text-faint">
            Reference <code className="font-mono">{error.digest}</code>
          </p>
        )}

        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button type="button" onClick={reset} className="btn-primary">
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Try again
          </button>
          <Link href="/console" className="btn-secondary">
            Console overview
          </Link>
        </div>
      </div>
    </div>
  );
}
