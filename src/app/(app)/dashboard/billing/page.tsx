import { requireTenant } from '@/lib/tenancy/request';
import { getQuota } from '@/lib/subscription';
import { parseJson } from '@/lib/types';
import { Card, Meter, PageHeader, StatusBadge } from '@/components/ui';
import { PricingTable } from '@/components/pricing-table';

export const metadata = { title: 'Plan & billing' };
export const dynamic = 'force-dynamic';

export default async function BillingPage() {
  const { user, run } = await requireTenant();

  // Plan is reference data, readable on the tenant path.
  const [plans, quota] = await Promise.all([
    run((tx) => tx.plan.findMany({ orderBy: { sortOrder: 'asc' } })),
    getQuota(user.id),
  ]);

  const planData = plans.map((p) => ({
    code: p.code,
    name: p.name,
    tagline: p.tagline,
    monthlyPriceCents: p.monthlyPriceCents,
    quarterlyPriceCents: p.quarterlyPriceCents,
    annualPriceCents: p.annualPriceCents,
    applicationsPerMonth: p.applicationsPerMonth,
    maxAgents: p.maxAgents,
    features: parseJson<string[]>(p.features, []),
    highlight: p.highlight,
  }));

  return (
    <>
      <PageHeader
        title="Plan & billing"
        description="Your application allowance resets monthly on every plan. Longer commitments cost less per month."
      />

      {quota && (
        <Card className="mb-8 p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold text-ink">{quota.planName} plan</h2>
                <StatusBadge status={quota.status === 'active' ? 'active' : quota.status} />
              </div>
              <p className="mt-1 text-sm text-muted">
                Billed {quota.interval} · renews{' '}
                {quota.periodEnd.toLocaleDateString('en-CA', {
                  month: 'long',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </p>
            </div>
            <div className="text-right">
              <p className="text-3xl font-bold tabular-nums text-ink">{quota.remaining}</p>
              <p className="text-xs text-muted">applications left</p>
            </div>
          </div>

          <div className="mt-5">
            <Meter used={quota.used} total={quota.limit} label="This cycle" />
          </div>
        </Card>
      )}

      <h2 className="mb-4 text-lg font-semibold text-ink">Change your plan</h2>
      <PricingTable plans={planData} signedIn currentPlanCode={quota?.planCode} />
    </>
  );
}
