import Link from 'next/link';
import { UserX } from 'lucide-react';

export default function CustomerNotFound() {
  return (
    <div className="mx-auto max-w-lg py-16">
      <div className="card p-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-raised">
          <UserX className="h-6 w-6 text-muted" aria-hidden="true" />
        </div>
        <h1 className="text-xl font-bold text-ink">No such customer</h1>
        <p className="mt-2 text-sm text-muted">
          That account id does not exist. It may have been a stale link from a ticket, or the row
          may have been removed — note that an erased account is anonymised in place and would
          still open here.
        </p>
        <Link href="/console/customers" className="btn-primary mt-6">
          Back to the customer book
        </Link>
      </div>
    </div>
  );
}
