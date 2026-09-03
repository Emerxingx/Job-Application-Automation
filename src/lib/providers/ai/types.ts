import type {
  InterviewPrepPackage,
  MatchAnalysis,
  ResumeContent,
  TailoredDocuments,
} from '@/lib/types';

export interface JobContext {
  title: string;
  company: string;
  location: string;
  description: string;
  requirements: string[];
  skills: string[];
  workMode: string;
  seniority?: string;
}

/**
 * Contract for the DETERMINISTIC intelligence layer.
 *
 * The implementation (`MockAIProvider`) is a real keyword/semantic engine, not
 * random numbers: scores are explainable and stable, and it is built only from
 * the résumé, so its output is evidence-grounded by construction. Stage 03
 * made it the engine of record: every task runs it first (as the baseline the
 * grounding checker falls back to per section), and it serves the whole
 * request whenever the tenant's policy, the prompt registry or the provider
 * does not permit an external model (`src/lib/ai/gateway.ts`).
 */
/** What the canonical job (Stage 06) says the posting requires, as the engine consumes it. */
export interface MatchRequirements {
  /** Skills the posting requires; a miss counts in full. */
  required: string[];
  /** Nice-to-haves; a miss counts half. */
  preferred: string[];
  /** Named credentials the posting requires; compared like required skills. */
  certifications: string[];
  /** The posting's stated minimum years when Stage 06 extracted one; the engine's own regex otherwise. */
  experienceYearsMin: number | null;
}

export interface MatchOptions {
  /** Per-dimension weights summing to 1; the engine's built-in constants when absent. */
  weights?: { skills: number; keywords: number; experience: number; seniority: number; location: number };
  /** Maps a skill to its canonical form under an equivalence map, so "postgres" and "postgresql" compare equal. */
  canonical?: (skill: string) => string;
  /** Stage 08: separated requirements from the canonical job; the posting's own text is the fallback. */
  requirements?: MatchRequirements;
}

export interface AIProvider {
  readonly name: string;

  /**
   * Predict how likely this resume is to clear ATS + recruiter screening.
   * Stage 08: the dimension weights and the skill equivalence map are
   * injected by the compatibility pipeline; the engine's own constants are
   * the fallback so every existing caller keeps its behaviour.
   */
  analyzeMatch(resume: ResumeContent, job: JobContext, options?: MatchOptions): Promise<MatchAnalysis>;

  /** Rewrite the resume and draft a cover letter against a specific posting. */
  tailor(resume: ResumeContent, job: JobContext, analysis: MatchAnalysis): Promise<TailoredDocuments>;

  /** Build an interview preparation pack for a submitted application. */
  prepareInterview(resume: ResumeContent, job: JobContext): Promise<InterviewPrepPackage>;
}

/** One structured-output request, fully rendered. The provider adds nothing. */
export interface CompletionRequest {
  model: string;
  system: string;
  prompt: string;
  /** JSON schema the response must satisfy; the provider constrains output to it. */
  schema: Record<string, unknown>;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  temperature?: number;
}

/**
 * Contract for an EXTERNAL model provider (Anthropic today).
 *
 * Deliberately narrow: it takes a rendered prompt and returns parsed JSON or
 * null. It holds no prompt text (the governed registry does — ADR-0019), makes
 * no routing decision (the gateway does — ADR-0015) and never falls back on
 * its own: a null is the gateway's signal to degrade explicitly and record it.
 * Only `src/lib/ai/gateway.ts` may call it (a static test enforces this).
 */
export interface ExternalModelProvider {
  readonly name: string;
  complete<T>(request: CompletionRequest): Promise<T | null>;
}
