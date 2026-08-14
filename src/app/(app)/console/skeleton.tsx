/**
 * Loading skeletons.
 *
 * Console queries are heavy — the revenue page reconstructs MRR from the whole
 * subscription event log — so these are on screen for a real fraction of a
 * second, not a token flash. They mirror the layout they stand in for, which is
 * what keeps the page from jumping when the data lands.
 *
 * `motion-reduce:animate-none` throughout: a grid of pulsing rectangles is
 * exactly the kind of thing that triggers vestibular symptoms.
 */

import { cn } from '@/components/ui';

export function Bar({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'block h-3.5 animate-pulse rounded bg-raised motion-reduce:animate-none',
        className,
      )}
    />
  );
}

export function KpiSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="card p-4">
          <Bar className="h-3 w-24" />
          <Bar className="mt-3 h-7 w-20" />
          <Bar className="mt-3 h-3 w-28" />
        </div>
      ))}
    </div>
  );
}

export function ChartSkeleton({ height = 260 }: { height?: number }) {
  return (
    <div className="card p-4">
      <Bar className="h-4 w-48" />
      <div
        className="mt-4 animate-pulse rounded-xl bg-raised motion-reduce:animate-none"
        style={{ height }}
      />
    </div>
  );
}

export function TableSkeleton({ rows = 8, columns = 6 }: { rows?: number; columns?: number }) {
  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap gap-3 border-b border-line p-3">
        <Bar className="h-9 w-64 rounded-xl" />
        <Bar className="h-9 w-36 rounded-xl" />
        <Bar className="h-9 w-36 rounded-xl" />
      </div>
      <div className="divide-y divide-line">
        {Array.from({ length: rows }, (_, rowIndex) => (
          <div key={rowIndex} className="flex items-center gap-4 px-4 py-3">
            {Array.from({ length: columns }, (_, columnIndex) => (
              <Bar
                key={columnIndex}
                className={cn('flex-1', columnIndex === 0 && 'max-w-[14rem]')}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The page title block, so the header does not pop into place. */
export function HeaderSkeleton() {
  return (
    <header className="mb-6">
      <Bar className="h-8 w-56 rounded-lg" />
      <Bar className="mt-2.5 h-4 w-80 max-w-full" />
    </header>
  );
}

/**
 * Wraps a whole page skeleton with the live-region plumbing.
 *
 * `aria-busy` plus a visually hidden message is what a screen reader announces;
 * without it a loading state is simply silence, which is indistinguishable from
 * a page that failed.
 */
export function LoadingFrame({ message, children }: { message: string; children: React.ReactNode }) {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">{message}</span>
      {children}
    </div>
  );
}
