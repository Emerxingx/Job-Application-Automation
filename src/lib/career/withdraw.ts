/**
 * Stage 16 (ADR-0031, review finding M4) - when a learning dataset's licence
 * is refused, its content must leave the product, including the copies a
 * stored plan carries: offering titles, provider names and the attribution
 * string in the analysis JSON, and the milestone titles derived from them.
 *
 * Called by `purgeDataset` BEFORE the rows are deleted (the milestone
 * lookup needs the offering ids). It rewrites, it does not delete: the plan
 * stays the person's record of what was computed, with each withdrawn step
 * and gap coverage replaced by a plain statement and the dataset key listed
 * under `withdrawn`. Deterministic and idempotent.
 */
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import type { TransitionAnalysis } from './engine';

type Client = Prisma.TransactionClient | typeof db;

export const WITHDRAWN_TITLE = 'Withdrawn: the dataset this step came from is no longer licensed';
export const WITHDRAWN_WHY = 'The licence for the dataset that supplied this step was withdrawn; the step no longer names it. Re-run the plan for a current pathway.';

/** Strip one dataset's content from an analysis. Returns the analysis unchanged (same object) when nothing cites the key. */
export function withdrawFromAnalysis(analysis: TransitionAnalysis, datasetKey: string, offeringIds: ReadonlySet<string>): { analysis: TransitionAnalysis; changed: boolean } {
  let changed = false;
  const pathway = analysis.pathway.map((step) => {
    if (step.provenance?.datasetKey !== datasetKey && !(step.offeringId && offeringIds.has(step.offeringId))) return step;
    changed = true;
    return { ...step, title: WITHDRAWN_TITLE, why: WITHDRAWN_WHY, offeringId: null, credentialId: step.provenance?.datasetKey === datasetKey ? null : step.credentialId, provenance: null };
  });
  const strip = (ids: string[] | null) => (ids === null ? null : ids.filter((id) => !offeringIds.has(id)));
  const skills = analysis.gaps.skills.map((g) => {
    const coveredBy = strip(g.coveredBy);
    if (coveredBy !== g.coveredBy && (coveredBy?.length ?? 0) !== (g.coveredBy?.length ?? 0)) changed = true;
    return { ...g, coveredBy };
  });
  const credentials = analysis.gaps.credentials.map((g) => {
    const coveredBy = strip(g.coveredBy);
    if ((coveredBy?.length ?? 0) !== (g.coveredBy?.length ?? 0)) changed = true;
    return { ...g, coveredBy };
  });
  const provenance = analysis.provenance.filter((p) => p.datasetKey !== datasetKey);
  if (provenance.length !== analysis.provenance.length) changed = true;
  const bridges = analysis.bridges.map((b) => (b.provenance?.datasetKey === datasetKey ? ((changed = true), { ...b, provenance: null }) : b));
  if (!changed) return { analysis, changed: false };
  const withdrawn = analysis.withdrawn ?? [];
  return { analysis: { ...analysis, pathway, gaps: { skills, credentials }, provenance, bridges, withdrawn: withdrawn.includes(datasetKey) ? withdrawn : [...withdrawn, datasetKey] }, changed: true };
}

/** Rewrite every plan and milestone that cites the dataset. System client, inside the purge transaction. */
export async function withdrawLearningDataset(tx: Client, dataset: { id: string; key: string }): Promise<{ plans: number; milestones: number }> {
  const offerings = await tx.learningOffering.findMany({ where: { datasetId: dataset.id }, select: { id: true } });
  const offeringIds = new Set(offerings.map((o) => o.id));
  const credentials = await tx.credential.findMany({ where: { datasetId: dataset.id }, select: { id: true } });
  const credentialIds = credentials.map((c) => c.id);
  const milestones = await tx.careerPlanMilestone.updateMany({
    where: { OR: [{ offeringId: { in: [...offeringIds] } }, { credentialId: { in: credentialIds } }] },
    data: { title: WITHDRAWN_TITLE, note: WITHDRAWN_WHY, offeringId: null, credentialId: null },
  });
  // Only plans whose JSON mentions the key or one of the ids are parsed.
  const candidates = await tx.careerPlan.findMany({ where: { analysis: { contains: dataset.key } }, select: { id: true, analysis: true } });
  let plans = 0;
  for (const p of candidates) {
    let parsed: TransitionAnalysis;
    try {
      parsed = JSON.parse(p.analysis) as TransitionAnalysis;
    } catch {
      continue;
    }
    const r = withdrawFromAnalysis(parsed, dataset.key, offeringIds);
    if (!r.changed) continue;
    await tx.careerPlan.update({ where: { id: p.id }, data: { analysis: JSON.stringify(r.analysis) } });
    plans += 1;
  }
  return { plans, milestones: milestones.count };
}
