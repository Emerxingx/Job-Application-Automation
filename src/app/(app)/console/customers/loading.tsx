import { HeaderSkeleton, LoadingFrame, TableSkeleton } from '../skeleton';

export default function ConsoleCustomersLoading() {
  return (
    <LoadingFrame message="Loading the customer book…">
      <HeaderSkeleton />
      <TableSkeleton rows={10} columns={7} />
    </LoadingFrame>
  );
}
