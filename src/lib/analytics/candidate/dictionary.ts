/**
 * Stage 13 — the candidate metric dictionary (ADR-0012 rule 1).
 *
 * Every number a candidate dashboard shows is defined HERE, once, in words a
 * candidate could check, and computed by the one function beside it. A
 * dashboard may not compute its own variant. `docs/governance/METRIC_DICTIONARY.md`
 * is the human copy of this table; a test fails when the two disagree.
 *
 * Counts are CUMULATIVE reach: "interviews" is every application that reached
 * at least the interview stage, whatever its status is today - so the funnel
 * decreases monotonically and a rate's denominator is always its parent stage.
 */
import { rate, type Rate } from '../types';

export interface OutcomeCounts {
  applications: number;
  sent: number;
  responded: number;
  screens: number;
  interviews: number;
  offers: number;
  hires: number;
  rejected: number;
  withdrawn: number;
  ghosted: number;
  expired: number;
  failed: number;
  sumMatchScore: number;
  responseSamples: number;
  sumResponseHrs: number;
}

export function emptyCounts(): OutcomeCounts {
  return { applications: 0, sent: 0, responded: 0, screens: 0, interviews: 0, offers: 0, hires: 0, rejected: 0, withdrawn: 0, ghosted: 0, expired: 0, failed: 0, sumMatchScore: 0, responseSamples: 0, sumResponseHrs: 0 };
}

export const COUNT_FIELDS: readonly (keyof OutcomeCounts)[] = ['applications', 'sent', 'responded', 'screens', 'interviews', 'offers', 'hires', 'rejected', 'withdrawn', 'ghosted', 'expired', 'failed', 'sumMatchScore', 'responseSamples', 'sumResponseHrs'];

/** Sum the count fields only - `into` may be a wider row (a mart row carries its keys too). */
export function addCounts<T extends OutcomeCounts>(into: T, from: OutcomeCounts): T {
  for (const k of COUNT_FIELDS) into[k] += from[k];
  return into;
}

export type CountMetricKey = 'applications' | 'sent' | 'responded' | 'screens' | 'interviews' | 'offers' | 'hires' | 'rejected' | 'withdrawn' | 'ghosted' | 'expired' | 'failed';
export type RateMetricKey = 'response_rate' | 'screen_rate' | 'interview_rate' | 'offer_rate' | 'hire_rate' | 'interview_from_response' | 'offer_from_interview';
export type ValueMetricKey = 'average_match_score' | 'average_response_hours';
export type MetricKey = CountMetricKey | RateMetricKey | ValueMetricKey;

export interface MetricDefinition {
  key: MetricKey;
  label: string;
  kind: 'count' | 'rate' | 'value';
  /** One sentence a candidate could verify against their own folder. */
  definition: string;
  /** For a rate: numerator / denominator, both count metrics. */
  numerator?: CountMetricKey;
  denominator?: CountMetricKey;
  /** Where the number comes from - always a mart column, never a transactional table. */
  source: string;
}

export const METRIC_DICTIONARY: readonly MetricDefinition[] = [
  { key: 'applications', label: 'Applications', kind: 'count', definition: 'Applications created in the period, attributed to the day the record was created - prepared or not, sent or not.', source: 'CandidateOutcomeMart.applications' },
  { key: 'sent', label: 'Sent', kind: 'count', definition: 'Applications that reached the employer: the record reached at least `submitted` (confirmed by you, or submitted on your instruction).', source: 'CandidateOutcomeMart.sent' },
  { key: 'responded', label: 'Employer replied', kind: 'count', definition: 'Sent applications where an employer responded: a response was recorded, or the record reached interviewing, offer or rejected.', source: 'CandidateOutcomeMart.responded' },
  { key: 'screens', label: 'Phone screens', kind: 'count', definition: 'Applications with at least one interview of kind `phone` recorded in the folder.', source: 'CandidateOutcomeMart.screens' },
  { key: 'interviews', label: 'Interviews', kind: 'count', definition: 'Applications that reached at least `interviewing` at any point (an offer counts, whatever the status is today).', source: 'CandidateOutcomeMart.interviews' },
  { key: 'offers', label: 'Offers', kind: 'count', definition: 'Applications that reached `offer` at any point.', source: 'CandidateOutcomeMart.offers' },
  { key: 'hires', label: 'Hires', kind: 'count', definition: 'Applications whose recorded outcome is `hired` (an offer you accepted).', source: 'CandidateOutcomeMart.hires' },
  { key: 'rejected', label: 'Rejected', kind: 'count', definition: 'Applications whose current status is `rejected`.', source: 'CandidateOutcomeMart.rejected' },
  { key: 'withdrawn', label: 'Withdrawn', kind: 'count', definition: 'Applications whose current status is `withdrawn`.', source: 'CandidateOutcomeMart.withdrawn' },
  { key: 'ghosted', label: 'Ghosted', kind: 'count', definition: 'Applications whose recorded outcome is `ghosted` - sent, never answered, closed by you.', source: 'CandidateOutcomeMart.ghosted' },
  { key: 'expired', label: 'Expired', kind: 'count', definition: 'Applications whose recorded outcome is `expired` - the posting closed before a decision.', source: 'CandidateOutcomeMart.expired' },
  { key: 'failed', label: 'Failed', kind: 'count', definition: 'Applications whose current status is `failed` - the preparation or a submission errored; nothing reached the employer.', source: 'CandidateOutcomeMart.failed' },
  { key: 'response_rate', label: 'Response rate', kind: 'rate', definition: 'Employer replied divided by Sent.', numerator: 'responded', denominator: 'sent', source: 'CandidateOutcomeMart.responded / sent' },
  { key: 'screen_rate', label: 'Screen rate', kind: 'rate', definition: 'Phone screens divided by Sent.', numerator: 'screens', denominator: 'sent', source: 'CandidateOutcomeMart.screens / sent' },
  { key: 'interview_rate', label: 'Interview rate', kind: 'rate', definition: 'Interviews divided by Sent.', numerator: 'interviews', denominator: 'sent', source: 'CandidateOutcomeMart.interviews / sent' },
  { key: 'offer_rate', label: 'Offer rate', kind: 'rate', definition: 'Offers divided by Sent.', numerator: 'offers', denominator: 'sent', source: 'CandidateOutcomeMart.offers / sent' },
  { key: 'hire_rate', label: 'Hire rate', kind: 'rate', definition: 'Hires divided by Sent.', numerator: 'hires', denominator: 'sent', source: 'CandidateOutcomeMart.hires / sent' },
  { key: 'interview_from_response', label: 'Interviews per reply', kind: 'rate', definition: 'Interviews divided by Employer replied - how many replies become a conversation.', numerator: 'interviews', denominator: 'responded', source: 'CandidateOutcomeMart.interviews / responded' },
  { key: 'offer_from_interview', label: 'Offers per interview', kind: 'rate', definition: 'Offers divided by Interviews - how many conversations become an offer.', numerator: 'offers', denominator: 'interviews', source: 'CandidateOutcomeMart.offers / interviews' },
  { key: 'average_match_score', label: 'Average match score', kind: 'value', definition: 'Mean compatibility score of the applications counted, one decimal; 0 when there are none.', source: 'CandidateOutcomeMart.sumMatchScore / applications' },
  { key: 'average_response_hours', label: 'Average time to first reply', kind: 'value', definition: 'Mean hours from sending to the first employer response, over applications that have both; an unanswered application is not counted as zero.', source: 'CandidateOutcomeMart.sumResponseHrs / responseSamples' },
];

export const METRIC_KEYS: readonly MetricKey[] = METRIC_DICTIONARY.map((m) => m.key);

export function metric(key: MetricKey): MetricDefinition {
  const found = METRIC_DICTIONARY.find((m) => m.key === key);
  if (!found) throw new Error(`Unknown metric ${key}`);
  return found;
}

/** The ONE way a rate is computed from counts. */
export function rateOf(key: RateMetricKey, counts: OutcomeCounts): Rate {
  const def = metric(key);
  return rate(counts[def.numerator!], counts[def.denominator!]);
}

export function valueOf(key: ValueMetricKey, counts: OutcomeCounts): number {
  if (key === 'average_match_score') return counts.applications === 0 ? 0 : Math.round((counts.sumMatchScore / counts.applications) * 10) / 10;
  return counts.responseSamples === 0 ? 0 : Math.round((counts.sumResponseHrs / counts.responseSamples) * 10) / 10;
}

/** The dimensions a cut may be taken on. `industry` is deliberately absent: no industry classification exists (NOC is occupation, not industry). */
export const DIMENSIONS = ['all', 'title', 'company', 'seniority', 'geography', 'source', 'resume_version', 'score_band'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const DIMENSION_LABELS: Record<Dimension, string> = {
  all: 'Everything',
  title: 'Job title',
  company: 'Company',
  seniority: 'Seniority',
  geography: 'Location',
  source: 'Job source',
  resume_version: 'Resume version',
  score_band: 'Match score band',
};

/** Score bands, closed at the top: 0-49, 50-69, 70-84, 85-100. */
export function scoreBand(score: number): string {
  if (score >= 85) return '85-100';
  if (score >= 70) return '70-84';
  if (score >= 50) return '50-69';
  return '0-49';
}

export const SENIORITIES = ['intern', 'junior', 'intermediate', 'senior', 'lead', 'manager', 'director', 'executive', 'unspecified'] as const;

/** Seniority read from the title's own words - the only place a posting says it. Pure and deterministic. */
export function seniorityOf(title: string): (typeof SENIORITIES)[number] {
  const t = ` ${title.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  if (/\b(intern|internship|co ?op)\b/.test(t)) return 'intern';
  if (/\b(chief|cto|ceo|cfo|coo|vp|vice president|president)\b/.test(t)) return 'executive';
  if (/\bdirector\b/.test(t)) return 'director';
  if (/\b(manager|head of)\b/.test(t)) return 'manager';
  if (/\b(lead|principal|staff)\b/.test(t)) return 'lead';
  if (/\b(senior|sr)\b/.test(t)) return 'senior';
  if (/\b(junior|jr|entry level|associate|graduate)\b/.test(t)) return 'junior';
  if (/\b(intermediate|mid level)\b/.test(t)) return 'intermediate';
  return 'unspecified';
}

// ---------------------------------------------------------------------------
// Small-cohort suppression (ADR-0012 rule 3)

/** A benchmark cut with fewer distinct people than this is never shown. */
export const MIN_COHORT = 5;

export interface Suppressible {
  users: number;
}

export type Suppressed<T> = { suppressed: false; value: T } | { suppressed: true; reason: string };

/** Apply the one suppression rule: a cohort under MIN_COHORT people yields no number, and says why. */
export function suppressSmallCohort<T extends Suppressible>(row: T | null | undefined): Suppressed<T> {
  if (!row || row.users < MIN_COHORT) return { suppressed: true, reason: `Fewer than ${MIN_COHORT} people are in this group, so no comparison is shown - a smaller group could identify someone.` };
  return { suppressed: false, value: row };
}
