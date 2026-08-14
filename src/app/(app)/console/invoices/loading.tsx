import { HeaderSkeleton, KpiSkeleton, LoadingFrame, TableSkeleton } from '../skeleton';

export default function ConsoleInvoicesLoading() {
  return (
    <LoadingFrame message="Loading invoices…">
      <HeaderSkeleton />
      <KpiSkeleton />
      <TableSkeleton rows={10} columns={7} />
    </LoadingFrame>
  );
}
