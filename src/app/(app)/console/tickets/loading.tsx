import { HeaderSkeleton, KpiSkeleton, LoadingFrame, TableSkeleton } from '../skeleton';

export default function ConsoleTicketsLoading() {
  return (
    <LoadingFrame message="Loading the support queue…">
      <HeaderSkeleton />
      <KpiSkeleton />
      <TableSkeleton rows={10} columns={6} />
    </LoadingFrame>
  );
}
