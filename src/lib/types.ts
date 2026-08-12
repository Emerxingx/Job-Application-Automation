// Shared domain types. These describe the JSON payloads stored in the
// string columns of the Prisma schema, plus the contracts between the
// provider layer and the application.

export type Country = 'CA' | 'US';
export type WorkMode = 'onsite' | 'hybrid' | 'remote' | 'any';
export type JobType = 'full_time' | 'part_time' | 'contract' | 'internship' | 'any';
export type BillingInterval = 'monthly' | 'quarterly' | 'annual';

export type ApplicationStatus =
  | 'queued'
  | 'applying'
  | 'submitted'
  | 'failed'
  | 'interviewing'
  | 'offer'
  | 'rejected'
  | 'withdrawn';

// --- Resume ----------------------------------------------------------------

export interface ResumeExperience {
  company: string;
  title: string;
  location?: string;
  startDate: string;
  endDate: string; // "Present" allowed
  bullets: string[];
}

export interface ResumeEducation {
  institution: string;
  credential: string;
  year: string;
  location?: string;
}

export interface ResumeContent {
  fullName: string;
  headline: string;
  email: string;
  phone?: string;
  location?: string;
  linkedinUrl?: string;
  portfolioUrl?: string;
  summary: string;
  skills: string[];
  experience: ResumeExperience[];
  education: ResumeEducation[];
  certifications: string[];
  projects?: { name: string; description: string }[];
}

// --- Matching --------------------------------------------------------------

export interface ScoreBreakdown {
  skills: number;
  experience: number;
  keywords: number;
  location: number;
  seniority: number;
}

export interface MatchAnalysis {
  matchScore: number;
  breakdown: ScoreBreakdown;
  matchedKeywords: string[];
  missingKeywords: string[];
  rationale: string;
}

// --- Tailoring -------------------------------------------------------------

export interface TailoringNotes {
  summaryRewritten: boolean;
  bulletsAdjusted: number;
  skillsReordered: boolean;
  keywordsInjected: string[];
  atsScore: number;
  changes: string[];
}

export interface TailoredDocuments {
  resumeText: string;
  resumeContent: ResumeContent;
  coverLetter: string;
  notes: TailoringNotes;
}

// --- Interview prep --------------------------------------------------------

export interface InterviewQuestion {
  question: string;
  category: 'behavioural' | 'technical' | 'situational' | 'culture' | 'closing';
  suggestedAnswer: string;
  tips: string[];
}

export interface StarStory {
  title: string;
  situation: string;
  task: string;
  action: string;
  result: string;
  mapsTo: string[];
}

export interface InterviewPrepPackage {
  questions: InterviewQuestion[];
  stories: StarStory[];
  companyResearch: string;
  questionsToAsk: string[];
}

// --- Job provider ----------------------------------------------------------

export interface JobSearchQuery {
  titles: string[];
  keywords?: string[];
  excludeKeywords?: string[];
  locations: string[];
  country?: Country;
  workMode?: WorkMode;
  jobType?: JobType;
  minSalary?: number;
  limit?: number;
}

export interface RawJobPosting {
  source: string;
  externalId: string;
  title: string;
  company: string;
  companyLogo?: string;
  location: string;
  country: Country;
  workMode: Exclude<WorkMode, 'any'>;
  jobType: Exclude<JobType, 'any'>;
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency: string;
  description: string;
  requirements: string[];
  skills: string[];
  nocCode?: string;
  applyUrl: string;
  applyMethod: 'external' | 'email' | 'ats_form';
  postedAt: Date;
}

export interface SubmissionResult {
  ok: boolean;
  confirmation?: string;
  failureReason?: string;
}

// --- Helpers ---------------------------------------------------------------

/** Parse a JSON column, falling back to a default when absent or malformed. */
export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
