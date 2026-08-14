'use client';

import { AreaChartCard, BarChartCard, DonutChartCard, LineChartCard } from '@/components/charts';

/**
 * The revenue page's charts.
 *
 * Every series arrives pre-bucketed and in integer cents; the chart components
 * do the dividing at the render boundary via `valueFormat="cents"`. Nothing
 * here computes a metric — if a number needs deriving it belongs in
 * lib/analytics/revenue.ts, where it can be unit-tested without a browser.
 */

export interface MovementPoint {
  label: string;
  newMrrCents: number;
  expansionMrrCents: number;
  reactivationMrrCents: number;
  /** Stored negative so the stack renders below the zero line. */
  contractionMrrCents: number;
  churnedMrrCents: number;
}

export interface ChurnPoint {
  label: string;
  churnedSubscribers: number;
  newSubscribers: number;
  reactivatedSubscribers: number;
}

export interface CashPoint {
  label: string;
  invoicedCents: number;
  paidCents: number;
  refundedCents: number;
}

export interface PlanSlice {
  id: string;
  label: string;
  value: number;
}

/**
 * MRR movement.
 *
 * Losses are passed in as negative numbers so the stack grows downward from
 * zero — the standard movement chart, where the reader sees at a glance whether
 * the month's bar sits above or below the axis. Drawing churn as a positive bar
 * beside new business is the common mistake; it makes a catastrophic month look
 * busy rather than bad.
 */
export function MrrMovementChart({
  data,
  currency,
  title,
}: {
  data: MovementPoint[];
  currency: string;
  title: string;
}) {
  return (
    <BarChartCard
      title={title}
      description="Above the line is money gained, below it money lost. The net is the difference, not the height of either half."
      data={data}
      xKey="label"
      stacked
      valueFormat="cents"
      currency={currency}
      height={280}
      series={[
        { key: 'newMrrCents', label: 'New' },
        { key: 'expansionMrrCents', label: 'Expansion' },
        { key: 'reactivationMrrCents', label: 'Reactivation' },
        { key: 'contractionMrrCents', label: 'Contraction' },
        { key: 'churnedMrrCents', label: 'Churn' },
      ]}
      emptyTitle="No subscription movement in this period"
      emptyDescription="Movement is written from the subscription event log — upgrades, downgrades and cancellations all appear here."
    />
  );
}

/** Subscriber counts. Separate from the MRR chart because they are not the same unit. */
export function SubscriberChurnChart({ data, title }: { data: ChurnPoint[]; title: string }) {
  return (
    <LineChartCard
      title={title}
      description="Logos, not dollars. A month that churns few customers can still churn a lot of revenue."
      data={data}
      xKey="label"
      valueFormat="number"
      height={260}
      series={[
        { key: 'newSubscribers', label: 'New' },
        { key: 'churnedSubscribers', label: 'Churned' },
        { key: 'reactivatedSubscribers', label: 'Reactivated' },
      ]}
      emptyTitle="No subscriber movement in this period"
      emptyDescription="New, churned and reactivated subscriptions are counted on the day their event was recorded."
    />
  );
}

/** Cash: billed, collected and returned. */
export function CashChart({
  data,
  currency,
  title,
}: {
  data: CashPoint[];
  currency: string;
  title: string;
}) {
  return (
    <AreaChartCard
      title={title}
      description="Billed on the invoice date, collected on the payment date. They do not reconcile within a period, and that gap is the point."
      data={data}
      xKey="label"
      valueFormat="cents"
      currency={currency}
      height={260}
      series={[
        { key: 'invoicedCents', label: 'Invoiced' },
        { key: 'paidCents', label: 'Collected' },
        { key: 'refundedCents', label: 'Refunded' },
      ]}
      emptyTitle="No cash movement in this period"
      emptyDescription="Invoices and settled payments plot here once there are any."
    />
  );
}

/** Where the recurring revenue actually comes from. */
export function PlanMixChart({
  slices,
  currency,
  totalLabel,
}: {
  slices: PlanSlice[];
  currency: string;
  totalLabel: string;
}) {
  return (
    <DonutChartCard
      title="MRR by plan"
      description="Share of current monthly recurring revenue, not of headcount."
      slices={slices}
      valueFormat="cents"
      currency={currency}
      height={240}
      centerValue={totalLabel}
      centerLabel="MRR"
      emptyTitle="No recurring revenue yet"
      emptyDescription="Once a subscription is active and billing, its plan appears here."
    />
  );
}
