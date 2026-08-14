import { Card } from '@/components/ui';

export default function DocumentsLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading your documents…</span>

      <header className="mb-6">
        <div className="h-8 w-40 animate-pulse rounded-lg bg-raised" />
        <div className="mt-2.5 h-4 w-96 max-w-full animate-pulse rounded bg-raised" />
      </header>

      <Card className="mb-6 p-5">
        <div className="h-4 w-40 animate-pulse rounded bg-raised" />
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="rounded-xl border border-line p-3">
              <div className="h-3.5 w-24 animate-pulse rounded bg-raised" />
              <div className="mt-2 h-3 w-full animate-pulse rounded bg-raised" />
              <div className="mt-3 h-8 w-28 animate-pulse rounded-xl bg-raised" />
            </div>
          ))}
        </div>
      </Card>

      <Card className="mb-5 p-3">
        <div className="flex flex-wrap gap-3">
          <div className="h-10 w-44 animate-pulse rounded-xl bg-raised" />
          <div className="h-10 w-64 max-w-full animate-pulse rounded-xl bg-raised" />
        </div>
      </Card>

      <Card className="divide-y divide-line p-0">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <div key={index} className="flex items-center gap-3 px-3 py-3.5">
            <div className="h-7 w-7 shrink-0 animate-pulse rounded-lg bg-raised" />
            <div className="min-w-0 flex-1">
              <div className="h-3.5 w-56 max-w-full animate-pulse rounded bg-raised" />
              <div className="mt-1.5 h-3 w-40 max-w-full animate-pulse rounded bg-raised" />
            </div>
            <div className="h-8 w-24 shrink-0 animate-pulse rounded-xl bg-raised" />
          </div>
        ))}
      </Card>
    </div>
  );
}
