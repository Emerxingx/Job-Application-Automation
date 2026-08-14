import { Bar, ChartSkeleton, HeaderSkeleton, KpiSkeleton, LoadingFrame } from './skeleton';

/**
 * The overview reconstructs MRR from the whole subscription event log, so this
 * is on screen long enough to matter. It mirrors the finished layout — two KPI
 * rows, two charts, two lists — so nothing shifts when the numbers arrive.
 */
export default function ConsoleOverviewLoading() {
  return (
    <LoadingFrame message="Loading the operations overview…">
      <HeaderSkeleton />
      <KpiSkeleton />
      <KpiSkeleton />

      <div className="mb-8 grid gap-4 lg:grid-cols-2">
        <ChartSkeleton height={240} />
        <ChartSkeleton height={240} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {[0, 1].map((column) => (
          <section key={column}>
            <Bar className="mb-3 h-5 w-40" />
            <div className="card divide-y divide-line p-0">
              {[0, 1, 2, 3, 4].map((row) => (
                <div key={row} className="flex items-center gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <Bar className="w-40" />
                    <Bar className="mt-2 h-3 w-56 max-w-full" />
                  </div>
                  <Bar className="h-5 w-20 rounded-lg" />
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </LoadingFrame>
  );
}
