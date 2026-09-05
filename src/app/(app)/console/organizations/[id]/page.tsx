import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui';
import { organizationDetail } from '@/lib/admin/organizations';
import { ssoKey } from '@/lib/sso/crypto';
import { consoleGate } from '../../guard';
import { AccessDenied } from '../../ui';
import { OrganizationDetailAdmin } from './organization-detail-admin';

export const metadata = { title: 'Organisation' };
export const dynamic = 'force-dynamic';

/** /console/organizations/:id - one organisation: status, tenant policy, SSO connection, SCIM tokens, members. Support reads; admins change under step-up. */
export default async function ConsoleOrganizationPage({ params }: { params: Promise<{ id: string }> }) {
  const gate = await consoleGate('support');
  if (!gate.ok) return <AccessDenied />;
  const { id } = await params;
  const org = await organizationDetail(id);
  if (!org) notFound();
  return (
    <>
      <PageHeader title={org.name} description={`${org.type} · ${org.slug} · ${org.status}${org.verifiedAt ? ` · verified by ${org.verifiedByEmail} on ${org.verifiedAt.toLocaleDateString('en-CA')}` : ' · not verified'}`} />
      <OrganizationDetailAdmin
        canChange={gate.staff.role === 'admin'}
        ssoKeyPresent={ssoKey() !== null}
        organization={{
          id: org.id,
          status: org.status,
          policy: org.policy,
          sso: org.sso ? { issuer: org.sso.issuer, clientId: org.sso.clientId, emailDomain: org.sso.emailDomain, jitProvisioning: org.sso.jitProvisioning, status: org.sso.status, lastSignInAt: org.sso.lastSignInAt?.toISOString() ?? null } : null,
          scimTokens: org.scimTokens.map((t) => ({ id: t.id, prefix: t.prefix, createdByEmail: t.createdByEmail, createdAt: t.createdAt.toISOString(), lastUsedAt: t.lastUsedAt?.toISOString() ?? null, revokedAt: t.revokedAt?.toISOString() ?? null })),
          members: org.members.map((m) => ({ userId: m.userId, email: m.email, fullName: m.fullName, role: m.role, serviceRole: m.serviceRole, acceptedAt: m.acceptedAt?.toISOString() ?? null, removedAt: m.removedAt?.toISOString() ?? null })),
        }}
      />
    </>
  );
}
