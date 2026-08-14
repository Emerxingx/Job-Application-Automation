import type { JobSearchQuery, RawJobPosting, SubmissionResult } from '@/lib/types';

/**
 * Contract every job source must satisfy.
 *
 * Swapping in a real source (Indeed, Adzuna, a Playwright scraper) means
 * implementing this interface and registering it in `providers/jobs/index.ts` —
 * no application code changes.
 */
export interface JobProvider {
  readonly name: string;

  /** Return live postings matching the query, newest first. */
  search(query: JobSearchQuery): Promise<RawJobPosting[]>;

  /**
   * Submit an application. Real providers drive an ATS form or send an email;
   * external-only postings should return a result flagged for manual apply.
   */
  submit(input: {
    job: RawJobPosting | { title: string; company: string; applyUrl: string; applyMethod: string };
    resumeText: string;
    coverLetter: string;
    applicant: { fullName: string; email: string; phone?: string };
  }): Promise<SubmissionResult>;
}
