import { Bar, HeaderSkeleton, KpiSkeleton, LoadingFrame } from '../../skeleton';

/**
 * The 360° view runs roughly eighteen queries in parallel, so the skeleton
 * mirrors its two-column shape rather than showing a spinner: the reader can
 * start orienting on where the subscription panel and the notes column will be
 * before either has data.
 */
export default function ConsoleCustomerLoading() {
  return (
    <LoadingFrame message="Loading the customer record…">
      <HeaderSkeleton />
      <div className="mb-6 flex gap-2">
        <Bar className="h-5 w-16 rounded-lg" />
        <Bar className="h-5 w-20 rounded-lg" />
      </div>
      <KpiSkeleton />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {[0, 1, 2].map((block) => (
            <div key={block}>
              <Bar className="mb-3 h-5 w-48" />
              <div className="card p-5">
                <div className="grid gap-4 sm:grid-cols-3">
                  {[0, 1, 2, 3, 4, 5].map((field) => (
                    <div key={field}>
                      <Bar className="h-3 w-20" />
                      <Bar className="mt-2 w-28" />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="space-y-6">
          {[0, 1, 2].map((block) => (
            <div key={block} className="card p-4">
              <Bar className="h-4 w-24" />
              <div className="mt-4 space-y-3">
                {[0, 1, 2, 3].map((row) => (
                  <Bar key={row} className="w-full" />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </LoadingFrame>
  );
}
