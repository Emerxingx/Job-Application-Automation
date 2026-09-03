import { listPromptVersions } from '@/lib/ai/prompt-registry';
import { db } from '@/lib/db';
import { PageHeader } from '@/components/ui';
import { consoleGate } from '../guard';
import { AccessDenied } from '../ui';
import { PromptAdmin, type PromptVersionView, type PromptAuditView } from './prompt-admin';

export const metadata = { title: 'Prompts' };
export const dynamic = 'force-dynamic';

/**
 * /console/prompts — the governed prompt registry (ADR-0019 Tier 1).
 *
 * Admin only, both here and in the layout. Every change goes through
 * /api/console/prompts with step-up re-authentication and lands in the audit
 * feed shown at the foot of the page, so what is deployed and who changed it
 * are visible on the same screen.
 */
export default async function ConsolePromptsPage() {
  const gate = await consoleGate('admin');
  if (!gate.ok) return <AccessDenied />;

  const [versions, audit] = await Promise.all([
    listPromptVersions(),
    db.auditLog.findMany({
      where: { entityType: 'PromptVersion' },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, action: true, summary: true, actorEmail: true, reason: true, createdAt: true },
    }),
  ]);

  const view: PromptVersionView[] = versions.map((v) => ({
    id: v.id,
    slug: v.slug,
    version: v.version,
    modelProvider: v.modelProvider,
    targetModel: v.targetModel,
    deploymentStatus: v.deploymentStatus,
    evaluationStatus: v.evaluationStatus,
    evaluationNote: v.evaluationNote,
    systemPrompt: v.systemPrompt,
    userPromptTemplate: v.userPromptTemplate,
    requiredVariables: v.requiredVariables,
    modelParameters: v.modelParameters,
    createdByEmail: v.createdByEmail,
    approvedByEmail: v.approvedByEmail,
    approvedAt: v.approvedAt?.toISOString() ?? null,
    updatedAt: v.updatedAt.toISOString(),
    notes: v.notes,
  }));
  const auditView: PromptAuditView[] = audit.map((a) => ({
    id: a.id,
    action: a.action,
    summary: a.summary,
    actorEmail: a.actorEmail,
    reason: a.reason,
    createdAt: a.createdAt.toISOString(),
  }));

  return (
    <>
      <PageHeader
        title="Prompt registry"
        description="Versioned system prompts for the AI gateway. A version serves traffic only after it is approved, has a recorded passed evaluation, and is promoted — each step re-authenticated and audited. Until a slug has a default, the gateway serves the deterministic engine for that task."
      />
      <PromptAdmin versions={view} audit={auditView} />
    </>
  );
}
