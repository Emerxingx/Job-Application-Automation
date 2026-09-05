/**
 * Stage 18 (ADR-0033) - the pipeline stage machine, a table. A submission
 * moves only along these edges, and never past `consent_requested` without a
 * GRANTED disclosure: the service checks the disclosure before every move
 * into a stage that shows the candidate to the employer. Pure.
 */
export const SUBMISSION_STAGES = ['sourced', 'consent_requested', 'consented', 'screening', 'interviewing', 'offered', 'hired', 'rejected', 'withdrawn'] as const;
export type SubmissionStage = (typeof SUBMISSION_STAGES)[number];

export const STAGE_TRANSITIONS: Record<SubmissionStage, readonly SubmissionStage[]> = {
  sourced: ['consent_requested', 'rejected', 'withdrawn'],
  consent_requested: ['consented', 'rejected', 'withdrawn'],
  consented: ['screening', 'interviewing', 'rejected', 'withdrawn'],
  screening: ['interviewing', 'offered', 'rejected', 'withdrawn'],
  interviewing: ['offered', 'rejected', 'withdrawn'],
  offered: ['hired', 'rejected', 'withdrawn'],
  hired: [],
  rejected: [],
  withdrawn: [],
};

/** Stages at or past which the employer sees the candidate's identity: a granted disclosure is required to enter them. */
export const DISCLOSED_STAGES: readonly SubmissionStage[] = ['consented', 'screening', 'interviewing', 'offered', 'hired'];

export function isSubmissionStage(value: unknown): value is SubmissionStage {
  return typeof value === 'string' && (SUBMISSION_STAGES as readonly string[]).includes(value);
}

export function canTransition(from: SubmissionStage, to: SubmissionStage): boolean {
  return STAGE_TRANSITIONS[from].includes(to);
}

export function requiresDisclosure(to: SubmissionStage): boolean {
  return DISCLOSED_STAGES.includes(to);
}

/** Where a time-to-X clock stops: the first event INTO the stage. */
export const MILESTONE_STAGES = { shortlist: 'screening', interview: 'interviewing', hire: 'hired' } as const;
