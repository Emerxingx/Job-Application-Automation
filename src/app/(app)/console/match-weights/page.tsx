import { BUILTIN_WEIGHTS, BUILTIN_WEIGHT_VERSION, getActiveWeights, listWeightVersions } from '@/lib/matching/weights';
import { db } from '@/lib/db';
import { PageHeader } from '@/components/ui';
import { consoleGate } from '../guard';
import { AccessDenied } from '../ui';
import { MatchWeightAdmin, type WeightAuditView, type WeightVersionView } from './match-weight-admin';

export const metadata = { title: 'Match weights' };
export const dynamic = 'force-dynamic';

/** /console/match-weights — the governed compatibility weight register (Stage 08). Admin only. */
export default async function ConsoleMatchWeightsPage() {
  const gate = await consoleGate('admin');
  if (!gate.ok) return <AccessDenied />;
  const [versions, active, audit] = await Promise.all([
    listWeightVersions(),
    getActiveWeights(),
    db.auditLog.findMany({ where: { entityType: 'MatchWeightVersion' }, orderBy: { createdAt: 'desc' }, take: 40, select: { id: true, action: true, summary: true, actorEmail: true, reason: true, createdAt: true } }),
  ]);
  const view: WeightVersionView[] = versions.map((v) => ({
    id: v.id,
    version: v.version,
    status: v.status,
    weights: v.weights,
    notes: v.notes,
    createdByEmail: v.createdByEmail,
    approvedByEmail: v.approvedByEmail,
    updatedAt: v.updatedAt.toISOString(),
  }));
  const auditView: WeightAuditView[] = audit.map((a) => ({ id: a.id, action: a.action, summary: a.summary, actorEmail: a.actorEmail, reason: a.reason, createdAt: a.createdAt.toISOString() }));
  return (
    <>
      <PageHeader
        title="Match weights"
        description="How the five compatibility dimensions combine into a score. A version is written as a draft, approved by a second admin, then activated — one active version, and activating an older approved version is the rollback. Every match records the version it was scored with, so a change never rewrites a stored score. Until a version is active, the built-in baseline applies and is recorded as such."
      />
      <MatchWeightAdmin versions={view} active={active} builtin={{ version: BUILTIN_WEIGHT_VERSION, weights: BUILTIN_WEIGHTS }} audit={auditView} />
    </>
  );
}
