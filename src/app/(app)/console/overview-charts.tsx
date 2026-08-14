'use client';

import { AreaChartCard, BarChartCard } from '@/components/charts';

/**
 * The overview's two trend charts.
 *
 * They live in a client component because Recharts measures the DOM, and they
 * take pre-bucketed points because bucketing is the server's job — the client
 * should never be deciding what a "day" is.
 *
 * Cash and signups are drawn separately rather than on twin axes. A dual-axis
 * chart lets the reader infer a relationship from where two lines happen to
 * cross, and the crossing point is an artefact of the scales, not of the
 * business.
 */

export interface RevenuePoint {
  label: string;
  invoicedCents: number;
  paidCents: number;
}

export interface SignupPoint {
  label: string;
  signups: number;
}

export function OverviewCharts({
  revenue,
  signups,
  currency,
  periodLabel,
}: {
  revenue: RevenuePoint[];
  signups: SignupPoint[];
  currency: string;
  periodLabel: string;
}) {
  return (
    <div className="mb-8 grid gap-4 lg:grid-cols-2">
      <AreaChartCard
        title={`Revenue — ${periodLabel}`}
        description="Billed on the day the invoice was issued; collected on the day the money arrived. They are different dates on purpose."
        data={revenue}
        xKey="label"
        valueFormat="cents"
        currency={currency}
        height={240}
        series={[
          { key: 'invoicedCents', label: 'Invoiced' },
          { key: 'paidCents', label: 'Collected' },
        ]}
        emptyTitle="No billing activity yet"
        emptyDescription="Invoices and payments will plot here as soon as the first one is raised."
      />

      <BarChartCard
        title={`New signups — ${periodLabel}`}
        description="Accounts created, whether or not they went on to subscribe."
        data={signups}
        xKey="label"
        valueFormat="number"
        height={240}
        series={[{ key: 'signups', label: 'Signups' }]}
        emptyTitle="No signups in this period"
        emptyDescription="Every new account appears here on the day it was created."
      />
    </div>
  );
}
