import { PageHeader } from '@/components/ui';
import { findUserByEmail } from '@/lib/admin/users';
import { listImpersonations } from '@/lib/admin/impersonation';
import { consoleGate } from '../guard';
import { AccessDenied } from '../ui';
import { UsersAdmin } from './users-admin';

export const metadata = { title: 'Users' };
export const dynamic = 'force-dynamic';

/** /console/users - one account by email: platform role, live sessions, memberships; admins assign the role, sign the person out everywhere, or start a read-only impersonation (Stage 20, ADR-0035). */
export default async function ConsoleUsersPage({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  const gate = await consoleGate('support');
  if (!gate.ok) return <AccessDenied />;
  const { email } = await searchParams;
  const user = email ? await findUserByEmail(email) : null;
  const impersonations = gate.staff.role === 'admin' ? await listImpersonations(20) : [];
  return (
    <>
      <PageHeader title="Users" description="Look an account up by email. The platform role is the ASSIGNMENT of a rank defined in code (ADR-0019); the console's allow-list still applies to whoever holds it. Impersonation is read-only, needs a reason, ends after sixty minutes, and is audited from start to end." />
      <UsersAdmin
        canChange={gate.staff.role === 'admin'}
        selfId={gate.staff.id}
        lookupEmail={email ?? ''}
        user={user ? { id: user.id, email: user.email, fullName: user.fullName, role: user.role, anonymized: user.anonymizedAt !== null, onboarded: user.onboardedAt !== null, createdAt: user.createdAt.toISOString(), sessions: user.sessions.map((s) => ({ id: s.id, method: s.method, createdAt: s.createdAt.toISOString(), lastSeenAt: s.lastSeenAt.toISOString(), expiresAt: s.expiresAt.toISOString() })), memberships: user.memberships.map((m) => ({ organizationId: m.organizationId, name: m.organization.name, type: m.organization.type, status: m.organization.status, role: m.role, serviceRole: m.serviceRole, accepted: m.acceptedAt !== null })) } : null}
        impersonations={impersonations.map((i) => ({ id: i.id, staffEmail: i.staffEmail, targetEmail: i.user.anonymizedAt ? '(erased)' : i.user.email, reason: i.reason, startedAt: i.startedAt.toISOString(), endedAt: i.endedAt?.toISOString() ?? null }))}
      />
    </>
  );
}
