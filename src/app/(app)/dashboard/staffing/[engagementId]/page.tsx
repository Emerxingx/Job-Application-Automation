import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { requireTenant } from '@/lib/tenancy/request';
import { requestMeta } from '@/lib/security-audit';
import { OrganizationAccessError } from '@/lib/tenancy/organizations';
import { StaffingError, loadEngagement, requireStaffingActor } from '@/lib/staffing/service';
import { PageHeader } from '@/components/ui';
import { StaffingEngagement } from '@/components/staffing-engagement';

export const dynamic = 'force-dynamic';

/** /dashboard/staffing/:engagementId - one engagement: the jurisdiction evaluation, representation, placements and invoices as the role may see them. */
export default async function EngagementPage({ params, searchParams }: { params: Promise<{ engagementId: string }>; searchParams: Promise<{ org?: string }> }) {
  const { engagementId } = await params;
  const { org } = await searchParams;
  if (!org) notFound();
  let view: Awaited<ReturnType<typeof loadEngagement>>;
  try {
    const { user, run } = await requireTenant(org);
    const actor = await requireStaffingActor({ id: user.id, email: user.email }, org, requestMeta(undefined));
    view = await run((tx) => loadEngagement(tx, actor, engagementId));
  } catch (error) {
    if (error instanceof StaffingError || error instanceof OrganizationAccessError) notFound();
    throw error;
  }
  return (
    <>
      <Link href={`/dashboard/staffing?org=${org}`} className="mb-5 inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-ink">
        <ArrowLeft className="h-4 w-4" />
        Staffing
      </Link>
      <PageHeader title={view.engagement.title} description={view.engagement.description || 'Engagement'} />
      <StaffingEngagement
        organizationId={org}
        view={{
          id: view.engagement.id,
          status: view.engagement.status,
          jurisdiction: view.engagement.jurisdiction,
          contract: { clientName: view.contract.clientName, status: view.contract.status, agencyLicenceRef: view.contract.agencyLicenceRef },
          fee: view.fee ? { name: view.fee.name, guaranteeDays: view.fee.guaranteeDays } : null,
          verdict: view.jurisdiction.verdict,
          checks: view.jurisdiction.checks,
          representations: view.representations.map((r) => ({ id: r.id, status: r.status, email: r.email, name: r.name })),
          placements: view.placements.map((p) => ({ id: p.id, status: p.status, startDate: p.startDate.toISOString(), feeCents: p.feeCents, currency: p.currency, guaranteeEndsAt: p.guaranteeEndsAt.toISOString(), invoices: p.invoices.map((i) => ({ id: i.id, number: i.number, status: i.status, creditedCents: i.creditedCents })) })),
          canWrite: view.canWrite,
          canRequest: view.canRequest,
          canInvoice: view.canInvoice,
        }}
      />
    </>
  );
}
