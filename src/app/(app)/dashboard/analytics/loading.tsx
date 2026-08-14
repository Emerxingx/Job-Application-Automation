import { Card } from '@/components/ui';

/**
 * Streamed while the metrics queries run. The skeleton mirrors the real
 * layout — KPI row, keyword panels, charts — so the page does not jump when
 * the numbers land.
 */
export default function AnalyticsLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading your analytics…</span>

      <header className="mb-6">
        <div className="h-8 w-44 animate-pulse rounded-lg bg-raised" />
        <div className="mt-2.5 h-4 w-72 max-w-full animate-pulse rounded bg-raised" />
      </header>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <Card key={index} className="p-4">
            <div className="h-3 w-24 animate-pulse rounded bg-raised" />
            <div className="mt-3 h-7 w-16 animate-pulse rounded bg-raised" />
            <div className="mt-3 h-3 w-28 animate-pulse rounded bg-raised" />
          </Card>
        ))}
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <div className="h-4 w-56 max-w-full animate-pulse rounded bg-raised" />
          <div className="mt-5 space-y-4">
            {[0, 1, 2, 3, 4].map((index) => (
              <div key={index}>
                <div className="h-3 w-40 max-w-full animate-pulse rounded bg-raised" />
                <div className="mt-2 h-1.5 w-full animate-pulse rounded-full bg-raised" />
              </div>
            ))}
          </div>
        </Card>
        <Card className="p-5">
          <div className="h-4 w-32 animate-pulse rounded bg-raised" />
          <div className="mt-5 space-y-4">
            {[0, 1, 2].map((index) => (
              <div key={index} className="h-3 w-full animate-pulse rounded bg-raised" />
            ))}
          </div>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <div className="h-4 w-48 animate-pulse rounded bg-raised" />
          <div className="mt-5 h-[240px] w-full animate-pulse rounded-xl bg-raised" />
        </Card>
        <Card className="p-5">
          <div className="h-4 w-36 animate-pulse rounded bg-raised" />
          <div className="mt-5 h-[240px] w-full animate-pulse rounded-xl bg-raised" />
        </Card>
      </div>
    </div>
  );
}
