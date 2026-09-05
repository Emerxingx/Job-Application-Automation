/**
 * Stage 16 (ADR-0031) - the transition engine. PURE: occupation nodes in,
 * an analysis out, every number derived from a row the caller can cite.
 *
 *   current occupation -> transferable skills -> target occupation -> gaps
 *   (skill / credential) -> difficulty -> market signal -> learning pathway
 *   -> experience bridge
 *
 * What it will not do: predict an outcome. There is no "probability of
 * getting hired", no salary, no "recognised employer". Recognition of a
 * credential is what its DATASET states (`recognition`), never inferred; the
 * market signal is a count of postings this deployment holds, labelled as
 * such. The `honesty` list travels with every analysis so a screen cannot
 * quietly drop the caveats.
 */

export const ENGINE_VERSION = '2026-09-05.1';

export interface GraphSkill {
  skillId: string;
  name: string;
  normalizedName: string;
  /** 1..5 when the dataset states one (OccupationSkill.importance); null otherwise. */
  importance: number | null;
  level: string | null;
}

export type CredentialRequirement = 'required' | 'preferred' | 'regulated';

export interface GraphCredential {
  credentialId: string;
  name: string;
  kind: string;
  requirement: CredentialRequirement;
  regulated: boolean;
  /** What the dataset states: regulated | industry | vendor | unverified. */
  recognition: string;
  /** Lower-case spellings the eligibility engine matches; the name itself is always one. */
  spellings: string[];
  provenance: Provenance | null;
}

export interface OccupationNode {
  id: string;
  title: string;
  teer: number | null;
  skills: GraphSkill[];
  credentials: GraphCredential[];
  provenance: Provenance | null;
}

export interface CandidateFacts {
  skills: { skillId: string | null; normalizedName: string; proficiency: string | null; yearsUsed: number | null }[];
  /** Certification names as the profile holds them. */
  certifications: string[];
}

export interface OfferingNode {
  id: string;
  title: string;
  providerName: string;
  deliveryMode: string;
  durationWeeks: number | null;
  durationHours: number | null;
  costCents: number | null;
  currency: string;
  credentialId: string | null;
  skillIds: string[];
  provenance: Provenance;
}

export interface MarketSignal {
  /** Open postings this deployment holds for the target occupation, posted in the last 30 days. */
  postings30d: number;
  postingsOpen: number;
}

export interface Provenance {
  datasetKey: string;
  attribution: string;
}

export interface Bridge {
  occupationId: string;
  title: string;
  /** The CareerPath kind the dataset recorded (e.g. progression, lateral). */
  kind: string;
  provenance: Provenance | null;
}

export interface TransitionInput {
  current: OccupationNode | null;
  target: OccupationNode;
  candidate: CandidateFacts;
  offerings: OfferingNode[];
  market: MarketSignal;
  bridges: Bridge[];
  now?: Date;
}

export interface SkillGap {
  skillId: string;
  name: string;
  importance: number | null;
  /** Offerings in the graph that state they teach this skill. */
  coveredBy: string[];
}

export interface CredentialGap {
  credentialId: string;
  name: string;
  requirement: CredentialRequirement;
  regulated: boolean;
  recognition: string;
  /** Offerings in the graph that lead to this credential. */
  coveredBy: string[];
}

export interface DifficultyFactor {
  factor: string;
  points: number;
  detail: string;
}

export interface PathwayStep {
  order: number;
  kind: 'credential' | 'learning' | 'experience';
  title: string;
  why: string;
  offeringId: string | null;
  credentialId: string | null;
  occupationId: string | null;
  /** The skill gaps this step closes. */
  closesSkillIds: string[];
  provenance: Provenance | null;
}

export interface TransitionAnalysis {
  engineVersion: string;
  computedAt: string;
  currentOccupationId: string | null;
  targetOccupationId: string;
  targetTitle: string;
  transferable: GraphSkill[];
  gaps: { skills: SkillGap[]; credentials: CredentialGap[] };
  difficulty: { score: number; band: 'low' | 'moderate' | 'high'; factors: DifficultyFactor[] };
  market: MarketSignal & { note: string };
  pathway: PathwayStep[];
  bridges: Bridge[];
  provenance: Provenance[];
  honesty: string[];
}

export const HONESTY = [
  'Posting counts are what this deployment holds for the occupation, not the labour market.',
  "A credential's recognition is what its dataset states; nothing is inferred and no employer's acceptance is promised.",
  'No outcome is predicted: not an interview, a hire or a salary. The pathway lists what the postings ask for and what these offerings state they teach.',
  'An offering appears only when its provider data enters under a recorded licence; an empty pathway can mean no licensed data yet, not that nothing exists.',
] as const;

/** The same normalisation the profile applies to a skill name. */
export function normalizeTerm(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#. ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasWholeWords(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const re = new RegExp(`(^|\\s)${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
  return re.test(haystack);
}

/** Whether the candidate holds a target skill: by id when both sides carry one, else by the normalised name. */
export function holdsSkill(candidate: CandidateFacts, skill: GraphSkill): boolean {
  return candidate.skills.some((c) => (c.skillId && c.skillId === skill.skillId) || (c.normalizedName && c.normalizedName === skill.normalizedName));
}

/** Whether the candidate's certifications name the credential by any of its spellings (whole words). */
export function holdsCredential(candidate: CandidateFacts, credential: Pick<GraphCredential, 'name' | 'spellings'>): boolean {
  const held = candidate.certifications.map(normalizeTerm).filter(Boolean);
  const spellings = [normalizeTerm(credential.name), ...credential.spellings.map(normalizeTerm)].filter(Boolean);
  return held.some((h) => spellings.some((sp) => h === sp || hasWholeWords(h, sp)));
}

const IMPORTANCE_DEFAULT = 3;

function skillPoints(importance: number | null): number {
  const i = importance ?? IMPORTANCE_DEFAULT;
  return Math.max(1, Math.min(5, i)) * 4; // 4..20
}

function credentialPoints(c: GraphCredential): number {
  if (c.requirement === 'regulated' || c.regulated) return 30;
  if (c.requirement === 'required') return 15;
  return 5;
}

export function difficultyBand(score: number): 'low' | 'moderate' | 'high' {
  if (score < 25) return 'low';
  if (score < 60) return 'moderate';
  return 'high';
}

/**
 * Greedy set cover: the offerings that together close the most skill gaps,
 * each chosen for the gaps it still adds. Deterministic: ties break by the
 * offering id, so the same graph always yields the same pathway.
 */
function chooseOfferings(gaps: SkillGap[], offerings: OfferingNode[]): { offering: OfferingNode; closes: string[] }[] {
  const uncovered = new Set(gaps.map((g) => g.skillId));
  const chosen: { offering: OfferingNode; closes: string[] }[] = [];
  const pool = [...offerings].sort((a, b) => a.id.localeCompare(b.id));
  while (uncovered.size > 0) {
    let best: { offering: OfferingNode; closes: string[] } | null = null;
    for (const o of pool) {
      const closes = o.skillIds.filter((s) => uncovered.has(s));
      if (closes.length === 0) continue;
      if (!best || closes.length > best.closes.length) best = { offering: o, closes };
    }
    if (!best) break;
    chosen.push(best);
    for (const s of best.closes) uncovered.delete(s);
  }
  return chosen;
}

export function analyseTransition(input: TransitionInput): TransitionAnalysis {
  const now = input.now ?? new Date();
  const target = input.target;
  const transferable = target.skills.filter((s) => holdsSkill(input.candidate, s));
  const missingSkills = target.skills.filter((s) => !holdsSkill(input.candidate, s));
  const skillGaps: SkillGap[] = missingSkills
    .map((s) => ({ skillId: s.skillId, name: s.name, importance: s.importance, coveredBy: input.offerings.filter((o) => o.skillIds.includes(s.skillId)).map((o) => o.id).sort() }))
    .sort((a, b) => (b.importance ?? IMPORTANCE_DEFAULT) - (a.importance ?? IMPORTANCE_DEFAULT) || a.name.localeCompare(b.name));
  const credentialGaps: CredentialGap[] = target.credentials
    .filter((c) => !holdsCredential(input.candidate, c))
    .map((c) => ({ credentialId: c.credentialId, name: c.name, requirement: c.requirement, regulated: c.regulated, recognition: c.recognition, coveredBy: input.offerings.filter((o) => o.credentialId === c.credentialId).map((o) => o.id).sort() }))
    .sort((a, b) => credentialPoints(target.credentials.find((c) => c.credentialId === b.credentialId)!) - credentialPoints(target.credentials.find((c) => c.credentialId === a.credentialId)!) || a.name.localeCompare(b.name));

  const factors: DifficultyFactor[] = [];
  for (const g of skillGaps) factors.push({ factor: `skill:${g.name}`, points: skillPoints(g.importance), detail: `${g.name} is ${g.importance !== null ? `importance ${g.importance} of 5` : 'listed'} for the target and not on your profile.` });
  for (const g of credentialGaps) {
    const c = target.credentials.find((x) => x.credentialId === g.credentialId)!;
    factors.push({ factor: `credential:${g.name}`, points: credentialPoints(c), detail: g.requirement === 'regulated' || g.regulated ? `${g.name} is a regulated licence the target requires to practise.` : g.requirement === 'required' ? `${g.name} is required by the target's postings.` : `${g.name} is preferred by the target's postings.` });
  }
  const sameFamily = input.current !== null && input.current.id !== target.id && input.bridges.length === 0 && input.current.teer !== null && target.teer !== null && input.current.teer === target.teer;
  if (input.current && sameFamily) factors.push({ factor: 'lateral', points: -5, detail: 'Same TEER level as your current occupation: a lateral move rather than a step up.' });
  const raw = factors.reduce((n, f) => n + f.points, 0);
  const score = Math.max(0, Math.min(100, raw));

  const pathway: PathwayStep[] = [];
  let order = 1;
  for (const g of credentialGaps) {
    const offering = input.offerings.filter((o) => o.credentialId === g.credentialId).sort((a, b) => a.id.localeCompare(b.id))[0] ?? null;
    pathway.push({
      order: order++,
      kind: 'credential',
      title: offering ? `${g.name} via ${offering.title} (${offering.providerName})` : `${g.name}`,
      why: g.requirement === 'regulated' || g.regulated ? 'Required to practise; without it the target is ineligible, not merely a weaker match.' : g.requirement === 'required' ? "The target's postings require it." : "The target's postings prefer it.",
      offeringId: offering?.id ?? null,
      credentialId: g.credentialId,
      occupationId: null,
      closesSkillIds: [],
      provenance: offering?.provenance ?? target.credentials.find((c) => c.credentialId === g.credentialId)?.provenance ?? null,
    });
  }
  const gapsNotClosedByCredentials = skillGaps.filter((g) => !pathway.some((p) => p.offeringId && input.offerings.find((o) => o.id === p.offeringId)?.skillIds.includes(g.skillId)));
  for (const pick of chooseOfferings(gapsNotClosedByCredentials, input.offerings)) {
    pathway.push({
      order: order++,
      kind: 'learning',
      title: `${pick.offering.title} (${pick.offering.providerName})`,
      why: `States it teaches ${pick.closes.map((id) => skillGaps.find((g) => g.skillId === id)?.name ?? id).join(', ')}.`,
      offeringId: pick.offering.id,
      credentialId: pick.offering.credentialId,
      occupationId: null,
      closesSkillIds: pick.closes,
      provenance: pick.offering.provenance,
    });
  }
  const stillOpen = gapsNotClosedByCredentials.filter((g) => !pathway.some((p) => p.closesSkillIds.includes(g.skillId)));
  if (stillOpen.length > 0) {
    pathway.push({
      order: order++,
      kind: 'learning',
      title: `No licensed offering in the graph covers ${stillOpen.map((g) => g.name).join(', ')} yet`,
      why: 'Skills the target lists that no ingested provider states it teaches. Real experience, recorded as approved evidence, closes them too.',
      offeringId: null,
      credentialId: null,
      occupationId: null,
      closesSkillIds: stillOpen.map((g) => g.skillId),
      provenance: null,
    });
  }
  for (const b of input.bridges) {
    pathway.push({ order: order++, kind: 'experience', title: `Bridge role: ${b.title}`, why: `The dataset records a ${b.kind} path from your current occupation through this role to the target.`, offeringId: null, credentialId: null, occupationId: b.occupationId, closesSkillIds: [], provenance: b.provenance });
  }

  const provenance: Provenance[] = [];
  const seen = new Set<string>();
  for (const p of [target.provenance, input.current?.provenance ?? null, ...target.credentials.map((c) => c.provenance), ...input.offerings.map((o) => o.provenance), ...input.bridges.map((b) => b.provenance)]) {
    if (p && !seen.has(p.datasetKey)) {
      seen.add(p.datasetKey);
      provenance.push(p);
    }
  }

  return {
    engineVersion: ENGINE_VERSION,
    computedAt: now.toISOString(),
    currentOccupationId: input.current?.id ?? null,
    targetOccupationId: target.id,
    targetTitle: target.title,
    transferable,
    gaps: { skills: skillGaps, credentials: credentialGaps },
    difficulty: { score, band: difficultyBand(score), factors },
    market: { ...input.market, note: input.market.postingsOpen === 0 ? 'No open postings for this occupation in this deployment right now.' : `${input.market.postingsOpen} open posting${input.market.postingsOpen === 1 ? '' : 's'} held here, ${input.market.postings30d} posted in the last 30 days.` },
    pathway,
    bridges: input.bridges,
    provenance,
    honesty: [...HONESTY],
  };
}

/**
 * The same analysis with an offering's stated skills added to the candidate:
 * how many gaps it would close and what the difficulty would become. Pure,
 * and explicit that it is a what-if.
 */
export function offeringCounterfactual(input: TransitionInput, offering: OfferingNode): { before: TransitionAnalysis; after: TransitionAnalysis; skillGapsClosed: number; difficultyDelta: number } {
  const before = analyseTransition(input);
  const learned = offering.skillIds.map((id) => input.target.skills.find((s) => s.skillId === id)).filter((s): s is GraphSkill => Boolean(s));
  const candidate: CandidateFacts = {
    ...input.candidate,
    skills: [...input.candidate.skills, ...learned.map((s) => ({ skillId: s.skillId, normalizedName: s.normalizedName, proficiency: null, yearsUsed: null }))],
    certifications: offering.credentialId ? [...input.candidate.certifications, input.target.credentials.find((c) => c.credentialId === offering.credentialId)?.name ?? ''] : input.candidate.certifications,
  };
  const after = analyseTransition({ ...input, candidate });
  return { before, after, skillGapsClosed: before.gaps.skills.length - after.gaps.skills.length, difficultyDelta: after.difficulty.score - before.difficulty.score };
}
