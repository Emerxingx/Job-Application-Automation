/**
 * Stage 16 (ADR-0031) - the career transition service: reads the graph on
 * the tenant path, runs the pure engine, stores the analysis as a VERSIONED
 * plan with milestones, and answers the counterfactual for a credential.
 *
 * Access is an entitlement (Stage 15): `career_transition_per_month` bounds
 * new analyses in a rolling 30-day window and `learning_recommendations`
 * decides whether offerings are shown or the pathway is returned locked
 * (the gaps are always shown - knowing what is missing is not the paid part).
 * Reference rows (occupations, credentials, offerings) are readable by every
 * tenant; plans and milestones are the person's own rows.
 */
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { normalizeSkill } from '@/lib/candidate/profile';
import { UNLIMITED } from '@/lib/entitlements/capabilities';
import { entitlementsFor } from '@/lib/entitlements/service';
import { allows, quantityOf } from '@/lib/entitlements/capabilities';
import { credentialCounterfactual, type EligibilityCounterfactual } from './counterfactual';
import { analyseTransition, normalizeTerm, type Bridge, type CandidateFacts, type GraphCredential, type OccupationNode, type OfferingNode, type Provenance, type TransitionAnalysis, ENGINE_VERSION } from './engine';
import type { CandidateEligibility, JobEligibilityFacts } from '@/lib/eligibility/engine';

type Client = Prisma.TransactionClient | typeof db;

export class CareerAccessError extends Error {
  readonly status: number;
  constructor(message: string, status = 403) {
    super(message);
    this.name = 'CareerAccessError';
    this.status = status;
  }
}

export class CareerError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'CareerError';
    this.status = status;
  }
}

const MARKET_WINDOW_DAYS = 30;

interface DatasetFact {
  id: string;
  key: string;
  name: string;
  attribution: string;
  licenceStatus: string;
  ingestionApproved: boolean;
}

/**
 * The datasets' key, attribution and licence state, read on the SYSTEM
 * client. `TaxonomyDataset` is system-only under RLS (Stage 04: it records
 * who recorded a licence), so the tenant role cannot see it and a relation
 * include on the tenant path comes back null - which would silently drop
 * every provenance and hide every licensed offering. This is reference
 * metadata, never a tenant's data, and it is the same read `attributionFor`
 * makes; nothing here is written. Loaded once per request and passed down.
 */
export async function datasetFacts(): Promise<Map<string, DatasetFact>> {
  const rows = await db.taxonomyDataset.findMany({ select: { id: true, key: true, name: true, attribution: true, licenceStatus: true, ingestionApproved: true } });
  return new Map(rows.map((r) => [r.id, r]));
}
export type DatasetFacts = Map<string, DatasetFact>;

function provenanceOf(datasetId: string | null | undefined, facts: DatasetFacts): Provenance | null {
  const d = datasetId ? facts.get(datasetId) : undefined;
  return d ? { datasetKey: d.key, attribution: d.attribution || d.name } : null;
}

/** A credential or offering counts only under a licence that is recorded and approved for ingestion (the Stage 04 gate, read at query time). */
function licensed(datasetId: string | null | undefined, facts: DatasetFacts): boolean {
  if (!datasetId) return true;
  const d = facts.get(datasetId);
  return d?.licenceStatus === 'recorded';
}

/** One occupation as the engine sees it: its labels, skills, credential requirements and provenance. */
export async function loadOccupationNode(client: Client, occupationId: string, locale = 'en', facts?: DatasetFacts): Promise<OccupationNode | null> {
  const f = facts ?? (await datasetFacts());
  const o = await client.occupation.findUnique({
    where: { id: occupationId },
    include: {
      labels: { where: { locale } },
      codes: true,
      skills: { include: { skill: true } },
      credentials: { include: { credential: true } },
    },
  });
  if (!o) return null;
  const teer = o.codes.find((c) => c.teer !== null)?.teer ?? null;
  return {
    id: o.id,
    title: o.labels[0]?.title ?? o.slug,
    teer,
    provenance: provenanceOf(o.datasetId, f),
    skills: o.skills.map((s) => ({ skillId: s.skillId, name: s.skill.name, normalizedName: s.skill.normalizedName, importance: s.importance, level: s.level })).sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0) || a.name.localeCompare(b.name)),
    credentials: o.credentials
      .filter((c) => licensed(c.credential.datasetId, f))
      .map((c) => ({ credentialId: c.credentialId, name: c.credential.name, kind: c.credential.kind, requirement: c.requirement as GraphCredential['requirement'], regulated: c.credential.regulated || c.requirement === 'regulated', recognition: c.credential.recognition, spellings: parseSpellings(c.credential.spellings), provenance: provenanceOf(c.credential.datasetId, f) })),
  };
}

function parseSpellings(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** The person's skills and certifications from the structured profile (Stage 02), on the tenant path. */
export async function loadCandidateFacts(tx: Client, userId: string): Promise<CandidateFacts> {
  const [skills, certifications] = await Promise.all([
    tx.candidateSkill.findMany({ where: { userId }, select: { skillId: true, normalizedName: true, proficiency: true, yearsUsed: true } }),
    tx.certification.findMany({ where: { userId }, select: { name: true } }),
  ]);
  return { skills: skills.map((s) => ({ skillId: s.skillId, normalizedName: normalizeSkill(s.normalizedName), proficiency: s.proficiency, yearsUsed: s.yearsUsed })), certifications: certifications.map((c) => c.name) };
}

/** Offerings under a RECORDED licence that teach any of the skills or lead to any of the credentials. */
export async function loadOfferings(client: Client, skillIds: string[], credentialIds: string[], facts?: DatasetFacts): Promise<OfferingNode[]> {
  if (skillIds.length === 0 && credentialIds.length === 0) return [];
  const f = facts ?? (await datasetFacts());
  const recorded = [...f.values()].filter((d) => d.licenceStatus === 'recorded' && d.ingestionApproved).map((d) => d.id);
  if (recorded.length === 0) return [];
  const rows = await client.learningOffering.findMany({
    where: {
      active: true,
      datasetId: { in: recorded },
      OR: [...(skillIds.length ? [{ skills: { some: { skillId: { in: skillIds } } } }] : []), ...(credentialIds.length ? [{ credentialId: { in: credentialIds } }] : [])],
    },
    include: { provider: { select: { name: true } }, skills: { select: { skillId: true } } },
    orderBy: { slug: 'asc' },
  });
  return rows.map((o) => ({ id: o.id, title: o.title, providerName: o.provider.name, deliveryMode: o.deliveryMode, durationWeeks: o.durationWeeks, durationHours: o.durationHours, costCents: o.costCents, currency: o.currency, credentialId: o.credentialId, skillIds: o.skills.map((s) => s.skillId), provenance: provenanceOf(o.datasetId, f) ?? { datasetKey: 'unknown', attribution: '' } }));
}

/** Postings this deployment holds for the occupation: open now, and posted in the last 30 days. */
export async function marketSignal(client: Client, occupationId: string, now = new Date()) {
  const since = new Date(now.getTime() - MARKET_WINDOW_DAYS * 86_400_000);
  const [postingsOpen, postings30d] = await Promise.all([
    client.job.count({ where: { occupationId, activeState: { not: 'closed' } } }),
    client.job.count({ where: { occupationId, activeState: { not: 'closed' }, postedAt: { gte: since } } }),
  ]);
  return { postingsOpen, postings30d };
}

/** One-hop bridges the dataset records from the current occupation towards the target (through an intermediate occupation). */
export async function loadBridges(client: Client, currentOccupationId: string | null, targetOccupationId: string, locale = 'en', facts?: DatasetFacts): Promise<Bridge[]> {
  if (!currentOccupationId || currentOccupationId === targetOccupationId) return [];
  const f = facts ?? (await datasetFacts());
  const first = await client.careerPath.findMany({ where: { fromOccupationId: currentOccupationId }, select: { toOccupationId: true, kind: true } });
  const mids = first.map((p) => p.toOccupationId).filter((id) => id !== targetOccupationId);
  if (mids.length === 0) return [];
  const second = await client.careerPath.findMany({ where: { fromOccupationId: { in: mids }, toOccupationId: targetOccupationId }, include: { from: { include: { labels: { where: { locale } } } } } });
  return second.map((p) => ({ occupationId: p.fromOccupationId, title: p.from.labels[0]?.title ?? p.from.slug, kind: p.kind, provenance: provenanceOf(p.from.datasetId, f) })).sort((a, b) => a.title.localeCompare(b.title));
}

export interface AnalysisResult {
  analysis: TransitionAnalysis;
  /** False when the person is not entitled to learning recommendations: the pathway's offerings are withheld and the reason stated. */
  offeringsShown: boolean;
  offeringsNote: string | null;
}

/** Run the engine for a person against a target, honouring the learning-recommendations entitlement. */
export async function analyseFor(tx: Client, userId: string, input: { targetOccupationId: string; currentOccupationId?: string | null }, now = new Date()): Promise<AnalysisResult> {
  const facts = await datasetFacts();
  const target = await loadOccupationNode(tx, input.targetOccupationId, 'en', facts);
  if (!target) throw new CareerError('No such occupation.', 404);
  const current = input.currentOccupationId ? await loadOccupationNode(tx, input.currentOccupationId, 'en', facts) : null;
  if (input.currentOccupationId && !current) throw new CareerError('No such current occupation.', 404);
  const [candidate, market, bridges, set] = await Promise.all([loadCandidateFacts(tx, userId), marketSignal(tx, target.id, now), loadBridges(tx, current?.id ?? null, target.id, 'en', facts), entitlementsFor(tx, userId, now)]);
  const showOfferings = allows(set, 'learning_recommendations');
  const offerings = showOfferings ? await loadOfferings(tx, target.skills.map((s) => s.skillId), target.credentials.map((c) => c.credentialId), facts) : [];
  const analysis = analyseTransition({ current, target, candidate, offerings, market, bridges, now });
  return { analysis, offeringsShown: showOfferings, offeringsNote: showOfferings ? null : 'Learning recommendations are not included in your plan; the gaps above are complete, the offerings that address them are not shown.' };
}

/** How many new analyses the person may still start this window, from the entitlement. */
export async function analysisBudget(tx: Client, userId: string, now = new Date()): Promise<{ limit: number; used: number; remaining: number; unlimited: boolean }> {
  const set = await entitlementsFor(tx, userId, now);
  const limit = quantityOf(set, 'career_transition_per_month');
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const used = await tx.careerPlan.count({ where: { userId, supersedesId: null, createdAt: { gte: since } } });
  const unlimited = limit >= UNLIMITED;
  return { limit, used, remaining: unlimited ? UNLIMITED : Math.max(0, limit - used), unlimited };
}

export interface CreatePlanInput {
  targetOccupationId: string;
  currentOccupationId?: string | null;
  title?: string;
}

/** A new plan (version 1) with milestones from the pathway; refused when the window's budget is spent. */
export async function createCareerPlan(tx: Client, userId: string, input: CreatePlanInput, now = new Date()) {
  const budget = await analysisBudget(tx, userId, now);
  if (budget.remaining <= 0) throw new CareerAccessError(budget.limit === 0 ? 'Career transition analysis is not included in your plan.' : `You have used the ${budget.limit} career analyses your plan includes in the last 30 days.`);
  const { analysis, offeringsShown } = await analyseFor(tx, userId, input, now);
  const plan = await tx.careerPlan.create({
    data: { userId, version: 1, status: 'active', title: input.title?.trim() || `Towards ${analysis.targetTitle}`, currentOccupationId: input.currentOccupationId ?? null, targetOccupationId: input.targetOccupationId, analysis: JSON.stringify(analysis), engineVersion: ENGINE_VERSION },
  });
  await writeMilestones(tx, userId, plan.id, analysis, offeringsShown);
  return plan;
}

async function writeMilestones(tx: Client, userId: string, planId: string, analysis: TransitionAnalysis, offeringsShown: boolean) {
  let sortOrder = 0;
  for (const step of analysis.pathway) {
    if (step.kind === 'learning' && step.offeringId === null && step.closesSkillIds.length > 0) {
      // The "nothing licensed covers this yet" step becomes one milestone per skill: real experience closes it.
      for (const skillId of step.closesSkillIds) {
        const gap = analysis.gaps.skills.find((g) => g.skillId === skillId);
        await tx.careerPlanMilestone.create({ data: { userId, planId, kind: 'experience', title: `Gain ${gap?.name ?? 'the skill'} through real work and record it as evidence`, status: 'planned', sortOrder: sortOrder++, note: step.why } });
      }
      continue;
    }
    await tx.careerPlanMilestone.create({
      data: { userId, planId, kind: step.kind, title: step.title, offeringId: offeringsShown ? step.offeringId : null, credentialId: step.credentialId, occupationId: step.occupationId, status: 'planned', sortOrder: sortOrder++, note: step.why },
    });
  }
}

/** Re-run the engine: a NEW version supersedes the current one (which is archived), milestones carried by title where still relevant. */
export async function refreshCareerPlan(tx: Client, userId: string, planId: string, now = new Date()) {
  const previous = await tx.careerPlan.findFirst({ where: { id: planId, userId }, include: { milestones: true } });
  if (!previous) throw new CareerError('No such plan.', 404);
  if (previous.status === 'archived') throw new CareerError('This plan version is archived; refresh the current one.', 409);
  const { analysis, offeringsShown } = await analyseFor(tx, userId, { targetOccupationId: previous.targetOccupationId, currentOccupationId: previous.currentOccupationId }, now);
  const next = await tx.careerPlan.create({
    data: { userId, version: previous.version + 1, status: 'active', title: previous.title, currentOccupationId: previous.currentOccupationId, targetOccupationId: previous.targetOccupationId, analysis: JSON.stringify(analysis), engineVersion: ENGINE_VERSION, supersedesId: previous.id },
  });
  await tx.careerPlan.update({ where: { id: previous.id }, data: { status: 'archived' } });
  await writeMilestones(tx, userId, next.id, analysis, offeringsShown);
  // Progress the person recorded is not lost: a done milestone with the same title stays done on the new version.
  const done = previous.milestones.filter((m) => m.status === 'done');
  for (const m of done) {
    await tx.careerPlanMilestone.updateMany({ where: { planId: next.id, userId, title: m.title }, data: { status: 'done', completedAt: m.completedAt, evidenceId: m.evidenceId } });
  }
  return next;
}

export async function archiveCareerPlan(tx: Client, userId: string, planId: string): Promise<boolean> {
  const r = await tx.careerPlan.updateMany({ where: { id: planId, userId, status: { not: 'archived' } }, data: { status: 'archived' } });
  return r.count > 0;
}

export const MILESTONE_STATUSES = ['planned', 'in_progress', 'done', 'dropped'] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

/** Move a milestone; `done` may cite an APPROVED evidence row of the person's own vault - never a claim without one being at least stated. */
export async function updateMilestone(tx: Client, userId: string, milestoneId: string, input: { status: MilestoneStatus; evidenceId?: string | null; note?: string }) {
  const m = await tx.careerPlanMilestone.findFirst({ where: { id: milestoneId, userId } });
  if (!m) throw new CareerError('No such milestone.', 404);
  let evidenceId: string | null = m.evidenceId;
  if (input.evidenceId !== undefined) {
    if (input.evidenceId === null) evidenceId = null;
    else {
      const ev = await tx.careerEvidence.findFirst({ where: { id: input.evidenceId, userId, status: 'approved' }, select: { id: true } });
      if (!ev) throw new CareerError('Cite one of your own approved evidence claims, or none.', 422);
      evidenceId = ev.id;
    }
  }
  return tx.careerPlanMilestone.update({ where: { id: m.id }, data: { status: input.status, completedAt: input.status === 'done' ? (m.completedAt ?? new Date()) : null, evidenceId, ...(input.note !== undefined ? { note: input.note } : {}) } });
}

export interface PlanView {
  id: string;
  version: number;
  status: string;
  title: string;
  currentOccupationId: string | null;
  targetOccupationId: string;
  engineVersion: string;
  supersedesId: string | null;
  createdAt: string;
  analysis: TransitionAnalysis;
  milestones: { id: string; kind: string; title: string; status: string; offeringId: string | null; credentialId: string | null; occupationId: string | null; dueAt: string | null; completedAt: string | null; evidenceId: string | null; note: string; sortOrder: number }[];
}

export async function loadPlan(tx: Client, userId: string, planId: string): Promise<PlanView | null> {
  const p = await tx.careerPlan.findFirst({ where: { id: planId, userId }, include: { milestones: { orderBy: { sortOrder: 'asc' } } } });
  if (!p) return null;
  return { id: p.id, version: p.version, status: p.status, title: p.title, currentOccupationId: p.currentOccupationId, targetOccupationId: p.targetOccupationId, engineVersion: p.engineVersion, supersedesId: p.supersedesId, createdAt: p.createdAt.toISOString(), analysis: JSON.parse(p.analysis) as TransitionAnalysis, milestones: p.milestones.map((m) => ({ id: m.id, kind: m.kind, title: m.title, status: m.status, offeringId: m.offeringId, credentialId: m.credentialId, occupationId: m.occupationId, dueAt: m.dueAt?.toISOString() ?? null, completedAt: m.completedAt?.toISOString() ?? null, evidenceId: m.evidenceId, note: m.note, sortOrder: m.sortOrder })) };
}

export async function listPlans(tx: Client, userId: string) {
  return tx.careerPlan.findMany({ where: { userId, status: { not: 'archived' } }, orderBy: { createdAt: 'desc' }, select: { id: true, version: true, status: true, title: true, targetOccupationId: true, engineVersion: true, createdAt: true, _count: { select: { milestones: true } } } });
}

/**
 * The counterfactual for one credential against one of the person's own
 * eligibility verdicts: the Stage 07 engine before and after. The job facts
 * and the candidate facts are the caller's (loaded on the tenant path); this
 * only adds the credential's spellings.
 */
export async function credentialWhatIf(client: Client, credentialId: string, candidate: CandidateEligibility, job: JobEligibilityFacts, today = new Date()): Promise<EligibilityCounterfactual & { credentialId: string; recognition: string; provenance: Provenance | null }> {
  const [c, facts] = await Promise.all([client.credential.findUnique({ where: { id: credentialId } }), datasetFacts()]);
  if (!c || !licensed(c.datasetId, facts)) throw new CareerError('No such credential.', 404);
  const result = credentialCounterfactual(candidate, job, { name: c.name, spellings: parseSpellings(c.spellings) }, today);
  return { ...result, credentialId: c.id, recognition: c.recognition, provenance: provenanceOf(c.datasetId, facts) };
}

export { normalizeTerm };
