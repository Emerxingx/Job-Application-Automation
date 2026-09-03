/**
 * The apply engine.
 *
 * A deliberate design decision runs through this module: JobPilot submits an
 * application programmatically only where the destination offers a supported,
 * authorized submission API. Everywhere else it prepares the application in
 * full and hands the applicant a one-click assisted submit.
 *
 * The reason is practical, not squeamish. The major aggregators (LinkedIn,
 * Indeed and most employer portals behind them) prohibit automated submission
 * in their terms, and they enforce it against the *applicant's* account. A
 * product that quietly drives those forms is spending its customers' accounts
 * to manufacture a metric. Assisted apply keeps the value — the tailored
 * resume, the cover letter, the folder, the tracking — without that risk.
 *
 * What the applicant loses in the assisted path is one click. What they keep
 * is the account their job search depends on.
 */

export type ApplyChannel =
  /** Submitted end-to-end by JobPilot against an authorized ATS API. */
  | 'ats_api'
  /** Prepared in full; the applicant confirms on the employer's own form. */
  | 'assisted'
  /** Nothing could be prepared — the posting is unreachable or malformed. */
  | 'unavailable';

/** Applicant-supplied fields an employer form will ask for. */
export interface ApplicantProfile {
  fullName: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  location?: string;
  linkedinUrl?: string;
  portfolioUrl?: string;
  workAuthorization?: string;
  requiresSponsorship?: boolean;
}

export interface ApplyRequest {
  job: {
    title: string;
    company: string;
    applyUrl: string;
    applyMethod: string;
    description?: string;
  };
  resumeText: string;
  coverLetter: string;
  applicant: ApplicantProfile;
}

/**
 * A field the employer's form is expected to ask for, paired with the value
 * JobPilot already knows. The assisted-apply UI renders these for one-click
 * copy, and a future browser extension can autofill straight from them.
 */
export interface PreparedField {
  /** Stable key, e.g. "email" or "cover_letter". */
  key: string;
  /** Human label as it typically appears on the form. */
  label: string;
  value: string;
  /** Long values render as a textarea rather than an input. */
  multiline?: boolean;
}

export interface ApplyOutcome {
  ok: boolean;
  channel: ApplyChannel;
  /** Which ATS was detected, when one was. */
  ats?: AtsVendor;
  /** Confirmation reference when the destination returned one. */
  confirmation?: string;
  /** Why an attempt did not complete, in words an applicant can act on. */
  failureReason?: string;
  /**
   * Present on the assisted path: everything needed to finish in one click.
   */
  assisted?: {
    applyUrl: string;
    fields: PreparedField[];
    /** Short instruction shown above the fields. */
    guidance: string;
  };
}

export type AtsVendor =
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'workable'
  | 'smartrecruiters'
  | 'workday'
  | 'bamboohr'
  | 'jazzhr'
  | 'recruitee';

export interface AtsTarget {
  vendor: AtsVendor;
  /** The employer's board/tenant identifier within that ATS. */
  tenant: string;
  /** The posting identifier within the tenant, when the URL carries one. */
  postingId?: string;
  /** True when this vendor has a submission API this build can drive. */
  submittable: boolean;
}

export interface ApplyProvider {
  readonly name: string;
  /**
   * Prepare everything the employer's form will ask for. NEVER submits —
   * in every provider, in every mode (Stage 12, ADR-0016). The outcome's
   * channel is `assisted` (with the prepared payload) or `unavailable`.
   */
  apply(request: ApplyRequest): Promise<ApplyOutcome>;
  /** Whether this deployment may submit programmatically to the posting's ATS, on the applicant's instruction, after their review. */
  canSubmit(request: ApplyRequest): boolean;
  /**
   * Submit through the employer-authorised ATS API. Called only from the
   * applicant's explicit instruction on a prepared application they have
   * reviewed. Null when no authorised channel exists.
   */
  submit(request: ApplyRequest): Promise<ApplyOutcome | null>;
}
