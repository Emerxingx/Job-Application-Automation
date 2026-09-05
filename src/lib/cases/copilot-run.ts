/**
 * Stage 17 (ADR-0032) - running the copilot for one case. The ONLY table it
 * writes is `CaseRecommendation`: an open recommendation for a pattern the
 * signals still show is refreshed, one for a pattern that has gone is marked
 * superseded, a new pattern is added. Nothing about the client changes; the
 * case manager decides each one (service.ts `decideRecommendation`).
 */
import { db } from '@/lib/db';
import { recordSecurityEvent } from '@/lib/security-audit';
import { clientSignalsFor } from './client-view';
import { COPILOT_VERSION, assessSignals } from './copilot';
import { CaseError, type CaseActor } from './service';
import { canWriteCase } from './roles';

export async function runCopilot(actor: CaseActor, caseId: string, now = new Date()) {
  const c = await db.case.findFirst({ where: { id: caseId, organizationId: actor.organizationId } });
  if (!c) throw new CaseError('Case not found.', 404);
  if (!canWriteCase(actor.role, c, actor.user.id)) throw new CaseError('Only the assigned case manager or an administrator runs the copilot.', 403);
  const { signals } = await clientSignalsFor(actor, caseId, now);
  const found = assessSignals(signals);
  const result = await db.$transaction(async (tx) => {
    const open = await tx.caseRecommendation.findMany({ where: { caseId: c.id, status: 'open' } });
    let added = 0;
    let refreshed = 0;
    let superseded = 0;
    for (const r of found) {
      const existing = open.find((o) => o.pattern === r.pattern);
      if (existing) {
        await tx.caseRecommendation.update({ where: { id: existing.id }, data: { severity: r.severity, detail: JSON.stringify(r.detail), suggestedAction: r.suggestedAction, copilotVersion: COPILOT_VERSION } });
        refreshed += 1;
      } else {
        await tx.caseRecommendation.create({ data: { caseId: c.id, organizationId: c.organizationId, pattern: r.pattern, severity: r.severity, detail: JSON.stringify(r.detail), suggestedAction: r.suggestedAction, copilotVersion: COPILOT_VERSION } });
        added += 1;
      }
    }
    for (const o of open) {
      if (!found.some((r) => r.pattern === o.pattern)) {
        await tx.caseRecommendation.update({ where: { id: o.id }, data: { status: 'superseded' } });
        superseded += 1;
      }
    }
    return { added, refreshed, superseded, patterns: found.map((r) => r.pattern) };
  });
  await recordSecurityEvent(
    { event: 'case.copilot.run', actor: { type: 'user', id: actor.user.id, email: actor.user.email, role: `case:${actor.role}` }, entityType: 'Case', entityId: c.id, summary: 'Copilot run: recommendations only', detail: { organizationId: c.organizationId, added: result.added, refreshed: result.refreshed, superseded: result.superseded, copilotVersion: COPILOT_VERSION }, meta: actor.meta },
    db,
    { strict: true },
  );
  return result;
}
