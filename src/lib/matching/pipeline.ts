import type { Job } from '@prisma/client';
import * as ai from '@/lib/ai/gateway';
import type { EvidenceBundle, GatewayResult } from '@/lib/ai/gateway';
import { extractSkills, normalize } from '@/lib/providers/ai/keywords';
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
 * with its score, weight, contribution, what matched and what was missing,
 * and the approved evidence ids that support it. The verdict never becomes
 * `résumé + JD → model → %`: the model, when policy allows one, only refines
 * the deterministic baseline inside the gateway's grounding.
 */

export const PIPELINE_VERSION = '2026-09-03.1';

export interface DimensionResult {
  dimension: Dimension;
  score: number;
  weight: number;
  /** score × weight, before the domain-fit scaling the engine applies to the total. */
  contribution: number;
  matched: string[];
  missing: string[];
  /** Approved CareerEvidence ids whose claims support the matched items. */
  evidenceIds: string[];
  note: string;
}

export interface CompatibilityResult {
  analysis: MatchAnalysis;
  dimensions: DimensionResult[];
  weightVersion: string;
  pipelineVersion: string;
  /** Posting terms satisfied only through the equivalence map. */
  semanticMatches: SemanticMatch[];
  run: GatewayResult<MatchAnalysis>['run'];
}

/** What Stage 06 extracted from the posting, as the compare stage reads it. */
export interface JobRequirements {
  requiredSkills: string[];
  preferredSkills: string[];
  experienceYearsMin: number | null;
  educationRequirements: string[];
  certificationRequirements: string[];
}

export function jobRequirements(job: Pick<Job, 'requiredSkills' | 'preferredSkills' | 'experienceYearsMin' | 'educationRequirements' | 'certificationRequirements'>): JobRequirements {
  return {
    requiredSkills: parseJson<string[]>(job.requiredSkills, []),
    preferredSkills: parseJson<string[]>(job.preferredSkills, []),
    experienceYearsMin: job.experienceYearsMin,
    educationRequirements: parseJson<string[]>(job.educationRequirements, []),
    certificationRequirements: parseJson<string[]>(job.certificationRequirements, []),
  };
}

/** The evidence rows whose claim mentions any of the terms (lexically, under the equivalence map). */
export function citeEvidence(entries: NonNullable<EvidenceBundle['entries']>, terms: string[], kinds?: string[]): string[] {
  const wanted = terms.map(canonicalSkill).filter(Boolean);
  if (wanted.length === 0) return [];
  const out: string[] = [];
  for (const e of entries) {
    if (kinds && !kinds.includes(e.kind)) continue;
    const claim = normalize(e.claim);
    const claimTerms = new Set([...extractSkills(claim), ...claim.split(' ')].map(canonicalSkill));
    if (wanted.some((w) => claimTerms.has(w) || (w.includes(' ') && claim.includes(w)))) out.push(e.id);
  }
  return out;
}

const NOTES: Record<Dimension, (d: { score: number; matched: string[]; missing: string[]; cited: number }) => string> = {
  skills: (d) => (d.matched.length + d.missing.length === 0 ? 'The posting names no skills the engine recognises; scored neutrally.' : `${d.matched.length} of ${d.matched.length + d.missing.length} named skills evidenced${d.cited ? ` (${d.cited} supporting evidence claim${d.cited === 1 ? '' : 's'})` : ''}.`),
  keywords: (d) => `Overlap with the posting's title, requirements and skills wording${d.cited ? `, ${d.cited} supporting claim${d.cited === 1 ? '' : 's'}` : ''}.`,
  experience: (d) => (d.cited ? `Years of experience against the posting's stated requirement, from ${d.cited} employment claim${d.cited === 1 ? '' : 's'}.` : 'Years of experience against the posting\'s stated requirement.'),
  seniority: () => 'Distance between the résumé\'s highest title level and the posting\'s.',
  location: () => 'City or province against the posting\'s; remote is always reachable.',
};

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

  // Requirement extraction: Stage 06's separated skills join the posting's
  // listed skills so the deterministic stage compares against what the
  // posting REQUIRES, not only what its skills field happened to carry.
  const jobSkillTerms = [...new Set([...context.skills, ...requirements.requiredSkills, ...requirements.preferredSkills].map((s) => normalize(s)).filter(Boolean))];
  const contextForEngine = { ...context, skills: jobSkillTerms };

  const result = await ai.analyzeMatch({ userId: input.userId, evidence: input.evidence, inputRefs: input.inputRefs }, input.resume, contextForEngine, { weights: active.weights, canonical: canonicalSkill });
  const analysis = result.value;

  // Semantic stage: which of the matched terms were satisfied only through
  // the equivalence map. Labelled, never hidden.
  const resumeTerms = [...extractSkills([input.resume.headline, input.resume.summary, input.resume.skills.join(' '), input.resume.experience.map((e) => `${e.title} ${e.bullets.join(' ')}`).join(' ')].join(' ')), ...input.resume.skills];
  const compared = compareTerms(analysis.matchedKeywords.map((k) => normalize(k)), resumeTerms);
  const semanticMatches = compared.matched.filter((m) => m.how === 'semantic');

  const entries = input.evidence.entries ?? [];
  const matchedNorm = analysis.matchedKeywords.map((k) => normalize(k));
  const missingNorm = analysis.missingKeywords.map((k) => normalize(k));
  const skillsCited = citeEvidence(entries, matchedNorm);
  const keywordCited = citeEvidence(entries, matchedNorm.slice(0, 12));
  const experienceCited = entries.filter((e) => e.kind === 'employment').map((e) => e.id);

  const dimensions: DimensionResult[] = DIMENSIONS.map((dimension) => {
    const score = analysis.breakdown[dimension];
    const weight = active.weights[dimension];
    const matched = dimension === 'skills' ? matchedNorm : dimension === 'keywords' ? matchedNorm.slice(0, 12) : [];
    const missing = dimension === 'skills' ? missingNorm : [];
    const evidenceIds = dimension === 'skills' ? skillsCited : dimension === 'keywords' ? keywordCited : dimension === 'experience' ? experienceCited : [];
    return {
      dimension,
      score,
      weight,
      contribution: Math.round(score * weight * 100) / 100,
      matched,
      missing,
      evidenceIds,
      note: NOTES[dimension]({ score, matched, missing, cited: evidenceIds.length }),
    };
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
