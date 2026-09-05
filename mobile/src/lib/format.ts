/** Pure formatting helpers; tested in tests/format.test.ts. No React, no platform. */

export function formatDate(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** "3 minutes ago", "2 days ago" - for the offline banner. */
export function formatAge(iso: string, now: Date = new Date()): string {
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function formatSalary(min: number | null, max: number | null, currency: string): string {
  const fmt = (n: number) => `${currency} ${Math.round(n).toLocaleString()}`;
  if (min !== null && max !== null) return min === max ? fmt(min) : `${fmt(min)} – ${fmt(max)}`;
  if (min !== null) return `From ${fmt(min)}`;
  if (max !== null) return `Up to ${fmt(max)}`;
  return 'Salary not stated';
}

/** The status vocabulary of the application machine (Stage 10), in words. */
export const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  preparing: 'Preparing',
  ready_to_submit: 'Ready to submit',
  applying: 'Submitting',
  submitted: 'Submitted',
  failed: 'Needs attention',
  interviewing: 'Interviewing',
  offer: 'Offer',
  rejected: 'Closed',
  withdrawn: 'Withdrawn',
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status.replace(/_/g, ' ');
}

export const MODE_LABELS: Record<string, string> = {
  recommend_only: 'Recommend only',
  prepare: 'Prepare for me',
  review_submit: 'Review & submit',
};

export const MODE_DESCRIPTIONS: Record<string, string> = {
  recommend_only: 'JobPilot recommends jobs; you apply on your own.',
  prepare: 'JobPilot prepares each application; you submit it on the employer form and confirm here.',
  review_submit: 'After you review a prepared application, you can instruct JobPilot to submit it through an employer-authorised system. Nothing is ever sent without your instruction.',
};

export function eligibilityLabel(outcome: string | undefined): string {
  switch (outcome) {
    case 'eligible':
      return 'You meet the hard requirements';
    case 'ineligible':
      return 'A hard requirement is not met';
    case 'unknown':
      return 'Some requirements could not be checked';
    default:
      return 'Not evaluated yet';
  }
}

/** Sentence-case a snake_case token for display. */
export function humanise(token: string): string {
  const words = token.replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

export function scoreBand(score: number): 'strong' | 'good' | 'weak' {
  if (score >= 75) return 'strong';
  if (score >= 50) return 'good';
  return 'weak';
}
