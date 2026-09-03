import type { ApplicationStatus } from '../types';

/**
 * Stage 10 — the application status machine, as data.
 *
 * Every allowed move is listed here and nowhere else; the service refuses
 * anything not in the table and writes a history row for everything in it.
 * The table is deliberately narrow: an application that was never sent
 * cannot be "interviewing", a rejected one does not come back, and the only
 * way out of `ready_to_submit` is the applicant's own confirmation or a
 * withdrawal — JobPilot never infers a submission it did not make.
 */
export const APPLICATION_STATUSES: readonly ApplicationStatus[] = ['queued', 'applying', 'ready_to_submit', 'submitted', 'failed', 'interviewing', 'offer', 'rejected', 'withdrawn'];

export const TRANSITIONS: Record<ApplicationStatus, readonly ApplicationStatus[]> = {
  queued: ['applying', 'failed', 'withdrawn'],
  applying: ['submitted', 'ready_to_submit', 'failed'],
  // `applying` from here is the CLAIM an instructed ATS submission takes before
  // it calls the employer (Stage 12): one caller wins, the rest are refused.
  ready_to_submit: ['submitted', 'withdrawn', 'applying'],
  submitted: ['interviewing', 'offer', 'rejected', 'withdrawn'],
  failed: ['queued', 'withdrawn'],
  interviewing: ['offer', 'rejected', 'withdrawn'],
  offer: ['interviewing', 'rejected', 'withdrawn'],
  rejected: [],
  withdrawn: [],
};

/** Statuses the applicant may record from the folder (the rest belong to the applicator and the confirmation path). */
export const APPLICANT_STATUSES: readonly ApplicationStatus[] = ['interviewing', 'offer', 'rejected', 'withdrawn'];

/** Statuses that mean the employer has the application. */
export const REACHED_EMPLOYER: readonly ApplicationStatus[] = ['submitted', 'interviewing', 'offer', 'rejected'];

export const TERMINAL_STATUSES: readonly ApplicationStatus[] = ['rejected', 'withdrawn'];

export const STATUS_LABELS: Record<ApplicationStatus, string> = {
  queued: 'queued',
  applying: 'being prepared',
  ready_to_submit: 'ready to submit',
  submitted: 'submitted',
  failed: 'failed',
  interviewing: 'interviewing',
  offer: 'at offer',
  rejected: 'not selected',
  withdrawn: 'withdrawn',
};

export function isApplicationStatus(value: unknown): value is ApplicationStatus {
  return typeof value === 'string' && (APPLICATION_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: ApplicationStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** The outcome a status change settles, when it settles one. */
export function outcomeFor(to: ApplicationStatus): 'rejected' | 'withdrawn' | null {
  if (to === 'rejected') return 'rejected';
  if (to === 'withdrawn') return 'withdrawn';
  return null;
}

export function describeRefusal(from: ApplicationStatus, to: ApplicationStatus): string {
  if (from === to) return `This application is already ${STATUS_LABELS[to]}.`;
  if (isTerminal(from)) return `This application is ${STATUS_LABELS[from]} and cannot change again.`;
  if (from === 'ready_to_submit' && to !== 'withdrawn' && to !== 'applying') return 'This application is awaiting your confirmation on the employer form; confirm it first.';
  if (!REACHED_EMPLOYER.includes(from) && REACHED_EMPLOYER.includes(to)) return `This application has not reached the employer yet (it is ${STATUS_LABELS[from]}).`;
  return `An application that is ${STATUS_LABELS[from]} cannot become ${STATUS_LABELS[to]}.`;
}
