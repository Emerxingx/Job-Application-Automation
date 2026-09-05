import { db } from '@/lib/db';
import { PageHeader } from '@/components/ui';
import { CAPABILITIES } from '@/lib/entitlements/capabilities';
import { describeEntitlements } from '@/lib/entitlements/service';
import { consoleGate } from '../guard';
import { AccessDenied } from '../ui';
import { EntitlementAdmin, type EntitlementAuditView, type EntitlementRowView } from './entitlement-admin';

export const metadata = { title: 'Entitlements' };
export const dynamic = 'force-dynamic';

/**
 * /console/entitlements - what an account may do, apart from what it paid
 * (Stage 15, ADR-0010). Look a person up by email; grant a comp, pilot,
 * licence or bonus with a reason under step-up; revoke with a reason.
 * Billing ops can look; admins change.
 */
export default async function ConsoleEntitlementsPage({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  const gate = await consoleGate('billing_ops');
  if (!gate.ok) return <AccessDenied />;
  const { email } = await searchParams;
  const user = email ? await db.user.findUnique({ where: { email: email.toLowerCase().trim() }, select: { id: true, email: true, fullName: true, subscription: { select: { status: true, plan: { select: { code: true, name: true } } } } } }) : null;
  const described = user ? await describeEntitlements(db, user.id) : null;
  const audit = await db.auditLog.findMany({ where: { action: { in: ['entitlement.granted', 'entitlement.revoked', 'billing.refund.recorded'] } }, orderBy: { createdAt: 'desc' }, take: 40, select: { id: true, action: true, summary: true, actorEmail: true, reason: true, createdAt: true, entityId: true } });
  const rows: EntitlementRowView[] = (described?.rows ?? []).map((r) => ({ id: r.id, capability: r.capability, kind: r.kind, quantity: r.quantity, source: r.source, sourceRef: r.sourceRef, grantedAt: r.grantedAt.toISOString(), grantedBy: r.grantedBy, expiresAt: r.expiresAt?.toISOString() ?? null, revokedAt: r.revokedAt?.toISOString() ?? null, revokedReason: r.revokedReason, note: r.note }));
  const resolved = described ? Object.entries(described.resolved).map(([capability, r]) => ({ capability, value: r.value, source: r.source })) : [];
  const auditView: EntitlementAuditView[] = audit.map((a) => ({ id: a.id, action: a.action, summary: a.summary, actorEmail: a.actorEmail, reason: a.reason, createdAt: a.createdAt.toISOString(), entityId: a.entityId }));
  return (
    <>
      <PageHeader
        title="Entitlements"
        description="What an account may do, decided apart from what it paid (ADR-0010). A plan grants rows when it activates and loses them when it lapses or is cancelled; a trial, a comp, a pilot, a licence or a bonus is a row of its own, granted here with a reason and revoked here with a reason. A refund never revokes anything by itself. Every change is an audit row."
      />
      <EntitlementAdmin
        canChange={gate.staff.role === 'admin'}
        lookupEmail={email ?? ''}
        user={user ? { id: user.id, email: user.email, fullName: user.fullName, plan: user.subscription?.plan.name ?? null, paymentStatus: user.subscription?.status ?? null } : null}
        rows={rows}
        resolved={resolved}
        capabilities={Object.entries(CAPABILITIES).map(([key, c]) => ({ key, kind: c.kind, description: c.description }))}
        audit={auditView}
      />
    </>
  );
}
