import { listAtsRulesets } from '@/lib/apply/ats-rulesets';
import { db } from '@/lib/db';
import { PageHeader } from '@/components/ui';
import { consoleGate } from '../guard';
import { AccessDenied } from '../ui';
import { AtsRulesetAdmin, type AtsAuditView, type AtsRulesetView } from './ats-ruleset-admin';

export const metadata = { title: 'ATS rulesets' };
export const dynamic = 'force-dynamic';

/** /console/ats-rulesets — the governed ruleset registry (ADR-0019 Tier 1), moved out of the CMS in Stage 05. Admin only. */
export default async function ConsoleAtsRulesetsPage() {
  const gate = await consoleGate('admin');
  if (!gate.ok) return <AccessDenied />;
  const [rulesets, audit] = await Promise.all([
    listAtsRulesets(),
    db.auditLog.findMany({ where: { entityType: 'AtsRuleset' }, orderBy: { createdAt: 'desc' }, take: 40, select: { id: true, action: true, summary: true, actorEmail: true, reason: true, createdAt: true } }),
  ]);
  const view: AtsRulesetView[] = rulesets.map((r) => ({
    id: r.id,
    platform: r.platform,
    version: r.version,
    status: r.status,
    navigationFlowType: r.navigationFlowType,
    pacing: r.pacing,
    selectorMap: r.selectorMap,
    fallbackSelectors: r.fallbackSelectors,
    notes: r.notes,
    createdByEmail: r.createdByEmail,
    approvedByEmail: r.approvedByEmail,
    updatedAt: r.updatedAt.toISOString(),
  }));
  const auditView: AtsAuditView[] = audit.map((a) => ({ id: a.id, action: a.action, summary: a.summary, actorEmail: a.actorEmail, reason: a.reason, createdAt: a.createdAt.toISOString() }));
  return (
    <>
      <PageHeader
        title="ATS rulesets"
        description="How the automation engine fills each job board's form. A version is written as a draft, approved by a second admin, then activated — one active version per platform, and activating an older approved version is the rollback. Every step is re-authenticated and audited. Pacing is standard or human-delay; there is no evasion setting."
      />
      <AtsRulesetAdmin rulesets={view} audit={auditView} />
    </>
  );
}
