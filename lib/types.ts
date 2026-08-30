export type JobType = "full-time" | "part-time" | "contract" | "internship";

export interface Job {
  id: string;
  title: string;
  company: string;
  location: string; // e.g. "Toronto, ON"
  remote: boolean;
  type: JobType;
  salaryRange?: string; // e.g. "$95,000 – $120,000 CAD"
  postedAt: string; // ISO date string
  description: string;
  requirements: string[];
  /** Populated once a live job-board integration (Indeed, Job Bank Canada, ...) is connected. */
  applyUrl: string;
  source: string; // e.g. "Job Bank Canada", "Indeed", "LinkedIn"
}

export type ApplicationStatus =
  | "saved"
  | "applied"
  | "interviewing"
  | "offer"
  | "rejected";

export interface Application {
  id: string;
  jobId: string;
  status: ApplicationStatus;
  notes?: string;
  coverLetter?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Profile {
  fullName: string;
  email: string;
  location: string;
  targetRoles: string[];
  skills: string[];
  yearsOfExperience?: number;
  /** Plain-text base resume the candidate maintains; used as grounding for AI generation. */
  resumeText: string;
  updatedAt: string;
}
