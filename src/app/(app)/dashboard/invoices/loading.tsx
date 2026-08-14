import { Card } from '@/components/ui';

export default function InvoicesLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading your invoices…</span>

      <header className="mb-6">
        <div className="h-8 w-40 animate-pulse rounded-lg bg-raised" />
        <div className="mt-2.5 h-4 w-80 max-w-full animate-pulse rounded bg-raised" />
      </header>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <Card key={index} className="p-4">
            <div className="h-3 w-28 animate-pulse rounded bg-raised" />
            <div className="mt-3 h-7 w-24 animate-pulse rounded bg-raised" />
            <div className="mt-3 h-3 w-36 max-w-full animate-pulse rounded bg-raised" />
          </Card>
        ))}
      </div>

      <div className="mb-3 h-6 w-36 animate-pulse rounded bg-raised" />
      <Card className="divide-y divide-line p-0">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <div key={index} className="flex items-center gap-4 px-3 py-3.5">
            <div className="h-3.5 w-28 animate-pulse rounded bg-raised" />
            <div className="hidden h-3.5 w-24 animate-pulse rounded bg-raised sm:block" />
            <div className="hidden h-3.5 flex-1 animate-pulse rounded bg-raised md:block" />
            <div className="ml-auto h-3.5 w-20 animate-pulse rounded bg-raised" />
            <div className="h-6 w-16 animate-pulse rounded-lg bg-raised" />
          </div>
        ))}
      </Card>
    </div>
  );
}
