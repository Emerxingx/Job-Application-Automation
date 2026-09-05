import { db } from '@/lib/db';
import type { DateRange } from '@/lib/analytics/types';

/**
 * Stage 21 (ADR-0036) - the console's OPERATIONAL QUEUES, kept apart from
 * its metrics on purpose.
 *
 * ADR-0012's rule is that no dashboard METRIC reads a transactional table:
 * every count, rate and series on the overview comes from a mart. A queue is
 * not a metric. "Which failed payments still owe money" and "who signed up
 * this morning" are work lists a person acts on now, and a stale work list
 * is wrong in a way a stale chart is not. So these two reads stay live,
 * bounded (a handful of rows, indexed), and live HERE - the one module the
 * static test allows to touch a transactional table from the console's
 * reporting pages. Add a count or a sum here and the test fails: that is a
 * metric, and it belongs in the dictionary and the rollup.
 */
export interface FailedPaymentRow {
  id: string;
  amountCents: number;
  currency: string;
  failureCode: string | null;
  createdAt: Date;
  failedAt: Date | null;
  user: { id: string; fullName: string; email: string };
  /** Open balance still owed by the customer - what separates a queue item from history. */
  outstandingCents: number;
}

export async function loadFailedPaymentsQueue(window: DateRange, take: number): Promise<FailedPaymentRow[]> {
  const rows = await db.payment.findMany({
    where: { status: 'failed', createdAt: { gte: window.start } },
    orderBy: { createdAt: 'desc' },
    take,
    select: { id: true, amountCents: true, currency: true, failureCode: true, createdAt: true, failedAt: true, user: { select: { id: true, fullName: true, email: true } } },
  });
  const ids = [...new Set(rows.map((r) => r.user.id))];
  const balances = ids.length ? await db.invoice.findMany({ where: { userId: { in: ids }, status: 'open' }, select: { userId: true, amountDueCents: true } }) : [];
  const owed = new Map<string, number>();
  for (const b of balances) owed.set(b.userId, (owed.get(b.userId) ?? 0) + b.amountDueCents);
  return rows.map((r) => ({ ...r, outstandingCents: owed.get(r.user.id) ?? 0 }));
}

export async function loadRecentSignups(take: number) {
  return db.user.findMany({
    orderBy: { createdAt: 'desc' },
    take,
    select: { id: true, fullName: true, email: true, city: true, country: true, createdAt: true, onboardedAt: true, subscription: { select: { status: true, plan: { select: { name: true } } } } },
  });
}
