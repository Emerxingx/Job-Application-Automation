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
 * Contract for the intelligence layer.
 *
 * The mock implementation is a real, deterministic keyword/semantic engine —
 * not random numbers — so scores are explainable and stable. The Anthropic
 * implementation swaps in an LLM for higher-quality rewriting while keeping
 * the same shape.
 */
export interface AIProvider {
  readonly name: string;

  /** Predict how likely this resume is to clear ATS + recruiter screening. */
  analyzeMatch(resume: ResumeContent, job: JobContext): Promise<MatchAnalysis>;

  /** Rewrite the resume and draft a cover letter against a specific posting. */
  tailor(resume: ResumeContent, job: JobContext, analysis: MatchAnalysis): Promise<TailoredDocuments>;

  /** Build an interview preparation pack for a submitted application. */
  prepareInterview(resume: ResumeContent, job: JobContext): Promise<InterviewPrepPackage>;
}
