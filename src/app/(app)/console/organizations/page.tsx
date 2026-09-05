import { PageHeader } from '@/components/ui';
import { listOrganizations } from '@/lib/admin/organizations';
import { consoleGate } from '../guard';
import { AccessDenied } from '../ui';
import { OrganizationsAdmin } from './organizations-admin';

export const metadata = { title: 'Organisations' };
export const dynamic = 'force-dynamic';

/** /console/organizations - every non-personal organisation: verification, status, policy, SSO. Support reads; admins create verified organisations and change policy (Stage 20, ADR-0035). */
export default async function ConsoleOrganizationsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const gate = await consoleGate('support');
  if (!gate.ok) return <AccessDenied />;
  const { q } = await searchParams;
  const rows = await listOrganizations({ q });
  return (
    <>
      <PageHeader title="Organisations" description="Employers, service providers and staffing agencies are created here once verified - self-service refuses those types. Suspension, the tenant policy (require SSO, allowed email domains, session ceiling), the SSO connection and SCIM tokens are administered per organisation under step-up, and every change is an audit row." />
      <OrganizationsAdmin canChange={gate.staff.role === 'admin'} query={q ?? ''} organizations={rows.map((o) => ({ id: o.id, name: o.name, slug: o.slug, type: o.type, status: o.status, verifiedAt: o.verifiedAt?.toISOString() ?? null, verifiedByEmail: o.verifiedByEmail, members: o.members, requireSso: o.requireSso, allowedEmailDomains: o.allowedEmailDomains, sessionMaxHours: o.sessionMaxHours, sso: o.sso, createdAt: o.createdAt.toISOString() }))} />
    </>
  );
}
