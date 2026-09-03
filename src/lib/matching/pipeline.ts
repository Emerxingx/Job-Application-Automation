import type { Job } from '@prisma/client';
import * as ai from '@/lib/ai/gateway';
import type { EvidenceBundle, GatewayResult } from '@/lib/ai/gateway';
import { combineScore, extractSkills, hasWord, isVocabularySkill, jobSignalText, normalize, resumeCorpusText, seniorityOf, tokenize } from '@/lib/providers/ai/keywords';
import type { JobContext, MatchRequirements } from '@/lib/providers/ai/types';
import type { MatchAnalysis, ResumeContent } from '@/lib/types';
import { parseJson } from '@/lib/types';
import { toJobContext } from '@/lib/services/scanner';
import { canonicalSkill, compareTerms, type SemanticMatch } from './semantic';
import { DIMENSIONS, getActiveWeights, type ActiveWeights, type Dimension } from './weights';

/**
 * Stage 08 — the compatibility pipeline (JOB_INTELLIGENCE_ARCHITECTURE
 * "Compatibility engine"), completed around the deterministic engine that is
 * PRESERVED as its deterministic stage:
 *
 *   parse (Stage 06 canonical job) → eligibility (Stage 07, before this runs)
 *   → requirement extraction → evidence retrieval → deterministic compare
 *   → semantic compare (equivalence map; pgvector is BLOCKED, see semantic.ts)
 *   → weighted score (governed weights, versioned) → explanation
 *
 * Every score is decomposable: one `DimensionResult` per named dimension
 * with its score, weight, contribution, what matched (and HOW — exactly or
 * through the equivalence map), what was missing (and whether it was a
 * requirement or a nice-to-have), and the approved evidence ids that
 * support it. The verdict never becomes `résumé + JD → model → %`: the
 * model, when policy allows one, only refines the deterministic baseline
 * inside the gateway's grounding, and the recorded score is ALWAYS the
 * governed weights applied to the grounded breakdown (`combineScore`),
 * whichever route served.
 */

/** Bumped when the assembly rules change, so a stored decomposition says which rules produced it. */
export const PIPELINE_VERSION = '2026-09-03.2';

export interface MatchedItem {
  /** The posting's term, normalised. */
  term: string;
  /** `exact` — the résumé holds the same term; `semantic` — an equivalent under the map (`via` says which). */
  how: 'exact' | 'semantic';
  via?: string;
}

export interface MissingItem {
  term: string;
  /** `required` / `preferred` from the canonical job; `wording` for a keyword-density token, which is not a requirement. */
  level: 'required' | 'preferred' | 'wording';
}

export interface DimensionResult {
  dimension: Dimension;
  score: number;
  weight: number;
  /** score × weight, before the domain-fit scaling the engine applies to the total. */
  contribution: number;
  matched: MatchedItem[];
  missing: MissingItem[];
  /** Approved CareerEvidence ids whose claims support the matched items. */
  evidenceIds: string[];
  note: string;
}

export interface CompatibilityResult {
  analysis: MatchAnalysis;
  dimensions: DimensionResult[];
  weightVersion: string;
  pipelineVersion: string;
  /** Posting terms satisfied only through the equivalence map (also carried on the skills dimension's `matched`). */
  semanticMatches: SemanticMatch[];
  run: GatewayResult<MatchAnalysis>['run'];
}

/**
 * What Stage 06 extracted from the posting, as the compare stage consumes
 * it. Education requirements are deliberately NOT here: the engine has no
 * education dimension and inventing one would change the weights contract;
 * they stay visible on the posting and are a stated limit (evidence §3).
 */
export type JobRequirements = MatchRequirements;

export function jobRequirements(job: Pick<Job, 'requiredSkills' | 'preferredSkills' | 'experienceYearsMin' | 'certificationRequirements'>): JobRequirements {
  return {
    required: parseJson<string[]>(job.requiredSkills, []),
    preferred: parseJson<string[]>(job.preferredSkills, []),
    certifications: parseJson<string[]>(job.certificationRequirements, []),
    experienceYearsMin: job.experienceYearsMin,
  };
}

/**
 * Vocabulary entries that are also ordinary English words. "Helped the
 * team go live" evidences nothing about Go; "Skill: Go" and "services in
 * Go" do. For these, a claim is cited only when it is a skill claim or
 * writes the term as a proper noun (capitalised, whole word). The residual —
 * a sentence-initial "Go live with…" — is accepted and stated.
 */
const AMBIGUOUS_TERMS = new Set([
  'go', 'r', 'rest', 'excel', 'swift', 'spark', 'rails', 'ruby', 'sketch', 'triage', 'sap', 'git', 'french', 'statistics',
  'forecasting', 'budgeting', 'documentation', 'communication', 'collaboration', 'leadership', 'mentoring', 'presentation',
  'accessibility', 'logistics', 'procurement', 'reconciliation', 'charting', 'experimentation', 'agile', 'scrum', 'kanban',
  'confluence', 'observability', 'prototyping', 'snowflake', 'pandas', 'java', 'angular', 'docker', 'linux',
]);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The term written capitalised, whole, and NOT at the start of the claim or
 * a sentence — where English capitalises any word ("Rest days were…").
 */
function writtenAsProperNoun(claim: string, term: string): boolean {
  const capitalised = term.charAt(0).toUpperCase() + term.slice(1);
  const pattern = new RegExp(`(^|[^A-Za-z0-9])${escapeRegex(capitalised)}([^A-Za-z0-9]|$)`, 'g');
  for (const m of claim.matchAll(pattern)) {
    const before = claim.slice(0, (m.index ?? 0) + m[1].length).replace(/[\s"“(\[]+$/, '');
    if (before.length > 0 && !/[.!?]$/.test(before)) return true;
  }
  return false;
}

/**
 * The evidence rows whose claim supports any of the terms, under the
 * equivalence map. A vocabulary term is found the way the engine finds it —
 * the boundary-aware pattern, never a bare token — and an ambiguous word
 * needs a skill claim or a proper-noun spelling; any other term must appear
 * as a whole word or phrase. Optionally restricted to evidence kinds.
 */
export function citeEvidence(entries: NonNullable<EvidenceBundle['entries']>, terms: string[], kinds?: string[]): string[] {
  // A one-letter term is only ever a vocabulary entry ("r"); anything else that short is noise.
  const wanted = [...new Set(terms.map(canonicalSkill).filter((t) => t.length >= 2 || isVocabularySkill(t)))];
  if (wanted.length === 0) return [];
  const out: string[] = [];
  for (const e of entries) {
    if (kinds && !kinds.includes(e.kind)) continue;
    const claim = normalize(e.claim);
    // The vocabulary spellings the claim carries, found the way the engine finds them.
    const spellings = extractSkills(claim);
    const supports = wanted.some((w) => {
      if (isVocabularySkill(w)) {
        const found = spellings.filter((s) => canonicalSkill(s) === w);
        if (found.length === 0) return false;
        if (e.kind === 'skill') return true;
        // "golang" is unambiguous however it is written; "go" needs a proper-noun spelling.
        return found.some((s) => !AMBIGUOUS_TERMS.has(s) || writtenAsProperNoun(e.claim, s));
      }
      // A plain word must carry signal (not a stop word, three letters or more) and appear whole.
      const usable = w.includes(' ') || (w.length >= 3 && tokenize(w).length > 0);
      return usable && hasWord(claim, w);
    });
    if (supports) out.push(e.id);
  }
  return out;
}

/** The keyword-density decomposition: the posting's signal tokens the résumé contains, and those it does not. */
export function keywordOverlap(job: JobContext, resume: ResumeContent): { overlap: string[]; absent: string[]; total: number } {
  const jobTokens = [...new Set(tokenize(jobSignalText(job)))];
  const resumeTokens = new Set(tokenize(resumeCorpusText(resume)));
  const overlap = jobTokens.filter((t) => resumeTokens.has(t)).sort();
  const absent = jobTokens.filter((t) => !resumeTokens.has(t)).sort();
  return { overlap, absent, total: jobTokens.length };
}

/** The résumé terms the semantic stage compares the posting's matched terms against — the same corpus the engine scored. */
function resumeTerms(resume: ResumeContent): string[] {
  return [...extractSkills(resumeCorpusText(resume)), ...resume.skills, ...resume.certifications];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Score one canonical job for one candidate. Deterministic for fixed inputs
 * and weights. The gateway records the AiRun; this records nothing itself —
 * the caller persists the dimensions with the JobMatch.
 */
export async function scoreCompatibility(input: {
  userId: string;
  resume: ResumeContent;
  evidence: EvidenceBundle;
  job: Job;
  inputRefs?: string[];
  weights?: ActiveWeights;
}): Promise<CompatibilityResult> {
  const active = input.weights ?? (await getActiveWeights());
  const context = toJobContext(input.job);
  const requirements = jobRequirements(input.job);

  // Requirement extraction: Stage 06's separated skills and credentials join
  // the posting's listed skills so the deterministic stage compares against
  // what the posting REQUIRES (and weighs a nice-to-have as such); its
  // extracted minimum years replaces the engine's regex when present.
  const jobSkillTerms = [...new Set([...context.skills, ...requirements.required, ...requirements.certifications, ...requirements.preferred].map((s) => normalize(s)).filter(Boolean))];
  const contextForEngine: JobContext = { ...context, skills: jobSkillTerms };

  const result = await ai.analyzeMatch({ userId: input.userId, evidence: input.evidence, inputRefs: input.inputRefs }, input.resume, contextForEngine, { weights: active.weights, canonical: canonicalSkill, requirements });
  // The recorded score is the governed weights applied to the grounded
  // breakdown on EVERY route. On the deterministic route this equals the
  // engine's own number; on an external route it replaces the model's, so
  // `weightVersion` and the contributions always describe the score.
  const analysis: MatchAnalysis = { ...result.value, matchScore: combineScore(result.value.breakdown, active.weights) };

  // Semantic stage: which matched terms were satisfied only through the
  // equivalence map. Labelled on the dimension row and shown on the page.
  const matchedNorm = analysis.matchedKeywords.map((k) => normalize(k));
  const missingNorm = analysis.missingKeywords.map((k) => normalize(k));
  const compared = compareTerms(matchedNorm, resumeTerms(input.resume));
  const howByTerm = new Map(compared.matched.map((m) => [m.required, m]));
  const semanticMatches = compared.matched.filter((m) => m.how === 'semantic');
  const skillsMatched: MatchedItem[] = matchedNorm.map((term) => {
    const m = howByTerm.get(term);
    return m && m.how === 'semantic' ? { term, how: 'semantic', via: m.satisfiedBy } : { term, how: 'exact' };
  });
  const requiredCanon = new Set([...requirements.required, ...requirements.certifications].map(canonicalSkill));
  const preferredCanon = new Set(requirements.preferred.map(canonicalSkill));
  const skillsMissing: MissingItem[] = missingNorm.map((term) => {
    const c = canonicalSkill(term);
    return { term, level: preferredCanon.has(c) && !requiredCanon.has(c) ? 'preferred' : 'required' };
  });
  const isPreferred = (term: string) => preferredCanon.has(canonicalSkill(term)) && !requiredCanon.has(canonicalSkill(term));

  // Keyword density decomposes into the tokens it actually measured.
  const density = keywordOverlap(contextForEngine, input.resume);

  const entries = input.evidence.entries ?? [];
  const employment = entries.filter((e) => e.kind === 'employment');
  const skillsCited = citeEvidence(entries, matchedNorm);
  const keywordCited = citeEvidence(entries, density.overlap);
  // Years of experience sum every dated role, so every employment claim fed it.
  const experienceCited = employment.map((e) => e.id);
  // Seniority is the highest title level; cite the employment claims carrying a title at that level.
  const topLevel = input.resume.experience.length ? Math.max(...input.resume.experience.map((e) => seniorityOf(e.title))) : null;
  const topTitles = topLevel === null ? [] : input.resume.experience.filter((e) => seniorityOf(e.title) === topLevel).map((e) => normalize(e.title)).filter(Boolean);
  const seniorityCited = employment.filter((e) => topTitles.some((t) => hasWord(normalize(e.claim), t))).map((e) => e.id);

  const requiredTotal = skillsMatched.filter((m) => !isPreferred(m.term)).length + skillsMissing.filter((m) => m.level === 'required').length;
  const requiredMatched = skillsMatched.filter((m) => !isPreferred(m.term)).length;
  const preferredTotal = skillsMatched.filter((m) => isPreferred(m.term)).length + skillsMissing.filter((m) => m.level === 'preferred').length;
  const preferredMatched = skillsMatched.filter((m) => isPreferred(m.term)).length;

  const notes: Record<Dimension, string> = {
    skills:
      requiredTotal + preferredTotal === 0
        ? 'The posting names no skills the engine recognises; scored neutrally.'
        : `${requiredMatched} of ${requiredTotal} required skills evidenced${preferredTotal ? `; ${preferredMatched} of ${preferredTotal} nice-to-haves` : ''}${semanticMatches.length ? ` (${semanticMatches.length} through the equivalence map)` : ''}${skillsCited.length ? ` — ${plural(skillsCited.length, 'supporting claim')}` : ''}.`,
    keywords: `${density.overlap.length} of ${density.total} terms from the posting's title, requirements and skills wording appear in the résumé${keywordCited.length ? `; ${plural(keywordCited.length, 'supporting claim')}` : ''}.`,
    experience: experienceCited.length ? `Years of experience against the posting's stated requirement, summed from ${plural(experienceCited.length, 'employment claim')}.` : "Years of experience against the posting's stated requirement.",
    seniority: `Highest résumé title level against the posting's title${seniorityCited.length ? `, from ${plural(seniorityCited.length, 'employment claim')}` : ''}.`,
    location: "Profile location against the posting's; remote is always reachable. A profile fact, not an evidence claim.",
  };

  const dimensions: DimensionResult[] = DIMENSIONS.map((dimension) => {
    const score = analysis.breakdown[dimension];
    const weight = active.weights[dimension];
    const matched: MatchedItem[] = dimension === 'skills' ? skillsMatched : dimension === 'keywords' ? density.overlap.map((term) => ({ term, how: 'exact' as const })) : [];
    const missing: MissingItem[] = dimension === 'skills' ? skillsMissing : dimension === 'keywords' ? density.absent.slice(0, 20).map((term) => ({ term, level: 'wording' as const })) : [];
    const evidenceIds = dimension === 'skills' ? skillsCited : dimension === 'keywords' ? keywordCited : dimension === 'experience' ? experienceCited : dimension === 'seniority' ? seniorityCited : [];
    return { dimension, score, weight, contribution: Math.round(score * weight * 100) / 100, matched, missing, evidenceIds, note: notes[dimension] };
  });

  return { analysis, dimensions, weightVersion: active.version, pipelineVersion: PIPELINE_VERSION, semanticMatches, run: result.run };
}

/** The columns a JobMatch row takes from a result, plus the dimension rows. */
export function matchRows(userId: string, result: CompatibilityResult) {
  return {
    match: {
      matchScore: result.analysis.matchScore,
      scoreBreakdown: JSON.stringify(result.analysis.breakdown),
      matchedKeywords: JSON.stringify(result.analysis.matchedKeywords),
      missingKeywords: JSON.stringify(result.analysis.missingKeywords),
      rationale: result.analysis.rationale,
      weightVersion: result.weightVersion,
      pipelineVersion: result.pipelineVersion,
    },
    dimensions: result.dimensions.map((d) => ({
      userId,
      dimension: d.dimension,
      score: d.score,
      weight: d.weight,
      contribution: d.contribution,
      matched: JSON.stringify(d.matched),
      missing: JSON.stringify(d.missing),
      evidenceIds: JSON.stringify(d.evidenceIds),
      note: d.note,
    })),
  };
}
