import { Bar, ChartSkeleton, HeaderSkeleton, KpiSkeleton, LoadingFrame } from '../skeleton';

/**
 * The heaviest page in the console: the opening MRR balance is reconstructed
 * from the entire subscription event log, because that is the only way a churn
 * rate gets an honest denominator. Expect this skeleton to be seen.
 */
export default function ConsoleRevenueLoading() {
  return (
    <LoadingFrame message="Loading revenue analytics…">
      <HeaderSkeleton />
      <KpiSkeleton />
      <KpiSkeleton />

      <Bar className="mb-3 h-5 w-40" />
      <div className="mb-4 grid gap-3 sm:grid-cols-3 xl:grid-cols-5">
        {[0, 1, 2, 3, 4].map((tile) => (
          <div key={tile} className="card p-3">
            <Bar className="h-3 w-20" />
            <Bar className="mt-2 h-5 w-24" />
          </div>
        ))}
      </div>
      <div className="mb-8">
        <ChartSkeleton height={280} />
      </div>

      <div className="mb-8 grid gap-4 lg:grid-cols-2">
        <ChartSkeleton height={240} />
        <ChartSkeleton height={260} />
      </div>

      <Bar className="mb-3 h-5 w-40" />
      <div className="card p-4">
        <div className="space-y-2">
          {[0, 1, 2, 3, 4, 5].map((row) => (
            <Bar key={row} className="h-8 w-full rounded-lg" />
          ))}
        </div>
      </div>
    </LoadingFrame>
  );
}
