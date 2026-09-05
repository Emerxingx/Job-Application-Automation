import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Handshake } from 'lucide-react';
import { requireTenant } from '@/lib/tenancy/request';
import { requestMeta } from '@/lib/security-audit';
import { OrganizationAccessError } from '@/lib/tenancy/organizations';
import { StaffingError, agencyMemberships, listContracts, listEngagements, listFeeStructures, listPlacementInvoices, requireStaffingActor } from '@/lib/staffing/service';
import { canReadFee, canReadInvoice } from '@/lib/staffing/roles';
import { EmptyState, PageHeader } from '@/components/ui';
import { StaffingWorkspace } from '@/components/staffing-workspace';

export const metadata = { title: 'Staffing' };
export const dynamic = 'force-dynamic';

/** /dashboard/staffing - Stage 19 (ADR-0034). An agency's contracts, fee structures, engagements and placement invoices, as the role may see them. */
export default async function StaffingPage({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  const params = await searchParams;
  const { user } = await requireTenant();
  const memberships = await agencyMemberships(user.id);
  if (memberships.length === 0) {
    return (
      <>
        <PageHeader title="Staffing" description="For staffing agencies placing candidates with their clients." />
        <EmptyState icon={<Handshake className="h-5 w-5" />} title="You are not a member of a staffing agency" description="An organisation administrator adds members. If an agency has asked to represent you, the request is under Settings." />
      </>
    );
  }
  const current = memberships.find((m) => m.organizationId === params.org) ?? memberships[0]!;
  let page: { actor: Awaited<ReturnType<typeof requireStaffingActor>>; contracts: Awaited<ReturnType<typeof listContracts>>; fees: Awaited<ReturnType<typeof listFeeStructures>> | null; engagements: Awaited<ReturnType<typeof listEngagements>>; invoices: Awaited<ReturnType<typeof listPlacementInvoices>> | null };
  try {
    const { run } = await requireTenant(current.organizationId);
    const actor = await requireStaffingActor({ id: user.id, email: user.email }, current.organizationId, requestMeta(undefined));
    const readsCommercial = actor.role !== 'viewer';
    const [contracts, fees, engagements, invoices] = await Promise.all([
      readsCommercial ? run((tx) => listContracts(tx, actor)) : Promise.resolve([]),
      canReadFee(actor.role) ? run((tx) => listFeeStructures(tx, actor)) : Promise.resolve(null),
      readsCommercial ? run((tx) => listEngagements(tx, actor)) : Promise.resolve([]),
      canReadInvoice(actor.role) ? run((tx) => listPlacementInvoices(tx, actor)) : Promise.resolve(null),
    ]);
    page = { actor, contracts, fees, engagements, invoices };
  } catch (error) {
    if (error instanceof StaffingError || error instanceof OrganizationAccessError) notFound();
    throw error;
  }
  const { actor, contracts, fees, engagements, invoices } = page;
  return (
    <>
      <PageHeader title="Staffing" description={`${current.name} · your role: ${actor.role}. Employer-paid placement: the client pays the fee; no candidate is charged. Jurisdiction rules are what counsel recorded; where none are recorded, nothing is invoiced.`} />
      {memberships.length > 1 ? (
        <p className="mb-4 text-sm text-muted">
          Organisation:{' '}
          {memberships.map((m) => (
            <Link key={m.organizationId} href={`/dashboard/staffing?org=${m.organizationId}`} className={m.organizationId === current.organizationId ? 'font-medium text-ink' : 'underline'}>
              {m.name}
            </Link>
          ))}
        </p>
      ) : null}
      <StaffingWorkspace
        organizationId={current.organizationId}
        role={actor.role}
        contracts={contracts.map((c) => ({ id: c.id, clientName: c.clientName, jurisdiction: c.jurisdiction, status: c.status, agencyLicenceRef: c.agencyLicenceRef, engagements: c._count.engagements }))}
        fees={fees ? fees.map((f) => ({ id: f.id, name: f.name, kind: f.kind, percentBps: f.percentBps, flatCents: f.flatCents, currency: f.currency, guaranteeDays: f.guaranteeDays })) : null}
        engagements={engagements.map((e) => ({ id: e.id, title: e.title, status: e.status, jurisdiction: e.jurisdiction, clientName: e.contract.clientName, representations: e._count.representations, placements: e._count.placements }))}
        invoices={invoices ? invoices.map((i) => ({ id: i.id, number: i.number, status: i.status, amountCents: i.amountCents, creditedCents: i.creditedCents, currency: i.currency, clientName: i.contract.clientName })) : null}
      />
    </>
  );
}
