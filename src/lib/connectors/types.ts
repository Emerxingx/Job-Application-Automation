import type { Country, JobSearchQuery, JobType, RawJobPosting, WorkMode } from '@/lib/types';

/**
 * The job source connector contract (ADR-0008, JOB_INTELLIGENCE_ARCHITECTURE
 * "Connector contract"):
 *
 *   discover · fetch · normalize · validate · refresh · detectClosed ·
 *   getApplicationRoute · healthCheck
 *
 * Every adapter implements all eight and passes the same contract suite
 * (tests/connector-contract.ts) before it may be enabled. The contract is
 * deliberately honest about what a source cannot do: `refresh` and
 * `detectClosed` return `unknown` when a source has no way to tell, and the
 * pipeline records that rather than inferring closure.
 *
 * WHAT A CONNECTOR MAY NOT DO (the ADR-0008 prohibitions, enforced at
 * review and by the source register): no CAPTCHA bypass, no access-control
 * circumvention, no fingerprint evasion, no restriction-defeating proxies.
 * A connector proposing any of these is rejected. Queries carry search
 * criteria only — never candidate identity (SOURCE_ACCESS_POLICY.md).
 */

/** ADR-0008 source classes, in strict priority order (1 = preferred). */
export const SOURCE_KINDS = ['api', 'feed', 'ats_board', 'career_page', 'aggregator', 'crawl', 'mock'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export const SOURCE_PRIORITY: Record<SourceKind, number> = { api: 1, feed: 2, ats_board: 3, career_page: 4, aggregator: 5, crawl: 6, mock: 7 };

/** A posting as the source hands it over, before normalisation. */
export type DiscoveredPosting = RawJobPosting;

/**
 * The canonical shape after `normalize`: what `Job` stores, plus the fields
 * Stage 06 will extend (normalised title, canonical hash). Stable, so the
 * snapshot payload is comparable across captures.
 */
export interface NormalizedPosting {
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
  postedAt: string; // ISO
}

export interface ValidationResult {
  ok: boolean;
  /** Stable reason codes, never free text from the source. */
  reasons: string[];
}

/** What refresh() learned about a posting the pipeline already holds. */
export type RefreshState = 'active' | 'closed' | 'unknown';

export interface ApplicationRoute {
  /** ats_api where an authorised submission API exists AND a credential is held; assisted or external otherwise. */
  channel: 'ats_api' | 'assisted' | 'external';
  vendor?: string;
}

export interface HealthReport {
  status: 'ok' | 'degraded' | 'down';
  latencyMs: number;
  /** Non-sensitive detail — an HTTP status, a count; never a body, never a credential. */
  detail: string;
}

export interface JobSourceConnector {
  readonly key: string;
  readonly name: string;
  readonly kind: SourceKind;
  /** Environment variable NAMES the adapter reads. Never values. */
  readonly credentialEnvVars: readonly string[];

  /** Find postings matching a query. Search criteria only. */
  discover(query: JobSearchQuery): Promise<DiscoveredPosting[]>;
  /** Fetch one posting in full, when the source can; null when it cannot or the posting is gone. */
  fetch(externalId: string): Promise<DiscoveredPosting | null>;
  /** Map a discovered posting to the canonical shape. Pure. */
  normalize(raw: DiscoveredPosting): NormalizedPosting;
  /** Reject malformed or unlawful-to-store postings. Pure. */
  validate(posting: NormalizedPosting): ValidationResult;
  /** Re-check postings the pipeline holds. Missing ids are `unknown`, not `closed`, unless the source says so. */
  refresh(externalIds: string[]): Promise<Record<string, RefreshState>>;
  /** Whether one posting has closed, when the source can tell. */
  detectClosed(externalId: string): Promise<RefreshState>;
  /** How an application should reach the employer for this posting. */
  getApplicationRoute(posting: NormalizedPosting): ApplicationRoute;
  /** Cheap liveness check against the source. Never throws. */
  healthCheck(): Promise<HealthReport>;
}
