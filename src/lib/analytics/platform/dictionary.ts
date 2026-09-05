/**
 * Stage 21 (ADR-0036) - the PLATFORM metric dictionary and the mart registry.
 *
 * ADR-0012 rule 1: every metric has exactly one definition, and a dashboard
 * may not compute its own variant. The candidate dictionary (Stage 13) holds
 * the candidate's metrics; this one holds everything else a staff or
 * organisation dashboard shows - founder/platform, financial, AI cost,
 * connector health, employer, staffing, case-manager/employment outcome,
 * career transition. `docs/governance/METRIC_DICTIONARY.md` mirrors it and a
 * test fails when they differ.
 *
 * Every metric names its MART. A dashboard reads that mart through the read
 * modules beside this file; the rollup jobs are the only readers of the
 * transactional tables, and a static test refuses a transactional query on a
 * reporting page or read module. Every mart publishes a refresh SLA: a page
 * shows when its mart was last rebuilt and says STALE past the SLA rather
 * than silently showing old numbers.
 */
export type ReportingProduct = 'platform' | 'financial' | 'ai' | 'connectors' | 'career' | 'employer' | 'staffing' | 'cases';

export type MetricKind = 'count' | 'cents' | 'rate' | 'distinct' | 'snapshot';

export interface PlatformMetricDefinition {
  key: string;
  product: ReportingProduct;
  label: string;
  kind: MetricKind;
  /** One sentence; the human copy in METRIC_DICTIONARY.md must match. */
  definition: string;
  /** `<Mart>.<column or metric>` - never a transactional table. */
  source: string;
}

/** The marts every reporting page reads, with the scope RLS gives them, EVERY job that writes them (a mart is fresh only when all have run) and the refresh SLA a page holds them to. */
export const MART_REGISTRY = {
  DailyMetric: { scope: 'system', partition: 'day', slaHours: 26, jobs: ['daily_metrics', 'platform_metrics'], description: 'Platform-wide daily counts and end-of-day snapshots (signups, activity, AI runs and cost, connector runs, open tickets, overdue invoices).' },
  DailyRevenueRollup: { scope: 'system', partition: 'day', slaHours: 26, jobs: ['daily_revenue'], description: 'One wide finance row per day per currency: cash, MRR and its movement, subscriber counts, payment outcomes.' },
  SubscriptionCohortMart: { scope: 'system', partition: 'day', slaHours: 26, jobs: ['subscription_cohorts'], description: 'Subscriber retention by start month and month offset, per currency.' },
  OrganizationDailyMart: { scope: 'org', partition: 'day', slaHours: 26, jobs: ['organization_reporting'], description: 'Per-organisation product facts by day: employer funnel and sources, staffing productivity, case outcomes.' },
  CandidateOutcomeMart: { scope: 'user', partition: 'day', slaHours: 26, jobs: ['candidate_outcomes'], description: 'Stage 13: the candidate\'s own application outcomes by dimension.' },
  CandidateMatchMart: { scope: 'user', partition: 'day', slaHours: 26, jobs: ['candidate_outcomes'], description: 'Stage 13: the candidate\'s match score bands and keywords by day.' },
  CandidateBenchmarkMart: { scope: 'system', partition: 'day', slaHours: 26, jobs: ['candidate_outcomes'], description: 'Stage 13: the platform benchmark, suppressed under five people.' },
} as const satisfies Record<string, { scope: 'system' | 'org' | 'user'; partition: 'day'; slaHours: number; jobs: readonly string[]; description: string }>;

export type MartName = keyof typeof MART_REGISTRY;
export const MART_NAMES = Object.keys(MART_REGISTRY) as MartName[];

/** Platform metrics written to `DailyMetric` for the DAY the fact happened (replace semantics over the range). */
export const PLATFORM_ACTIVITY_METRICS = ['signups', 'applications_submitted', 'active_users', 'failed_payments', 'ai_runs', 'ai_refused', 'ai_cost_cents', 'connector_runs', 'connector_failures', 'jobs_captured', 'career_plans_created', 'career_plans_refreshed', 'organizations_verified', 'sso_sign_ins'] as const;
/** Point-in-time metrics written to `DailyMetric` ONLY for the as-of day of the run; earlier days keep what their own run recorded. */
export const PLATFORM_SNAPSHOT_METRICS = ['open_tickets', 'breached_tickets', 'overdue_invoices', 'overdue_invoice_cents', 'active_organizations', 'live_sessions'] as const;

export const EMPLOYER_METRICS = ['submissions', 'consented', 'screening', 'interviewing', 'offered', 'hired', 'rejected', 'withdrawn', 'stage_moves', 'days_to_screening', 'days_to_interviewing', 'days_to_hired'] as const;
export const STAFFING_METRICS = ['engagements_opened', 'representations_requested', 'representations_granted', 'placements', 'placements_fell_off_in_guarantee', 'placement_fee_cents', 'invoices_issued', 'invoices_paid', 'invoices_credited'] as const;
export const CASES_METRICS = ['cases_opened', 'cases_closed', 'outcomes', 'follow_ups_due', 'follow_ups_completed'] as const;

export const PLATFORM_METRIC_DICTIONARY: readonly PlatformMetricDefinition[] = [
  // --- founder / platform -------------------------------------------------
  { key: 'signups', product: 'platform', label: 'Signups', kind: 'count', definition: 'Accounts created that day (UTC).', source: 'DailyMetric.signups' },
  { key: 'applications_submitted', product: 'platform', label: 'Applications submitted', kind: 'count', definition: 'Applications whose appliedAt falls on the day.', source: 'DailyMetric.applications_submitted' },
  { key: 'active_users', product: 'platform', label: 'Active users', kind: 'distinct', definition: 'Distinct accounts with any usage event that day.', source: 'DailyMetric.active_users' },
  { key: 'organizations_verified', product: 'platform', label: 'Organisations verified', kind: 'count', definition: 'Organisations staff verified that day (verifiedAt).', source: 'DailyMetric.organizations_verified' },
  { key: 'sso_sign_ins', product: 'platform', label: 'SSO sign-ins', kind: 'count', definition: 'Successful sign-ins through an organisation\'s SSO that day (audit rows auth.sso.succeeded).', source: 'DailyMetric.sso_sign_ins' },
  { key: 'active_organizations', product: 'platform', label: 'Active organisations', kind: 'snapshot', definition: 'Non-personal organisations with status active at the end of the as-of day.', source: 'DailyMetric.active_organizations' },
  { key: 'live_sessions', product: 'platform', label: 'Live sessions', kind: 'snapshot', definition: 'Sessions neither revoked nor expired at the end of the as-of day.', source: 'DailyMetric.live_sessions' },
  { key: 'open_tickets', product: 'platform', label: 'Open support tickets', kind: 'snapshot', definition: 'Tickets whose status is open, pending or on_hold at the end of the as-of day.', source: 'DailyMetric.open_tickets' },
  { key: 'breached_tickets', product: 'platform', label: 'Tickets past SLA', kind: 'snapshot', definition: 'Open tickets flagged breachedSla at the end of the as-of day.', source: 'DailyMetric.breached_tickets' },
  // --- financial ------------------------------------------------------------
  { key: 'failed_payments', product: 'financial', label: 'Failed payments', kind: 'count', definition: 'Payments that failed that day (failedAt), any currency.', source: 'DailyMetric.failed_payments' },
  { key: 'overdue_invoices', product: 'financial', label: 'Overdue invoices', kind: 'snapshot', definition: 'Open invoices past their due date at the end of the as-of day.', source: 'DailyMetric.overdue_invoices' },
  { key: 'overdue_invoice_cents', product: 'financial', label: 'Overdue amount', kind: 'snapshot', definition: 'Amount due on overdue open invoices at the end of the as-of day, in cents, any currency (a count of money owed, not a sum to be converted).', source: 'DailyMetric.overdue_invoice_cents' },
  { key: 'mrr', product: 'financial', label: 'Monthly recurring revenue', kind: 'cents', definition: 'Normalised contracted monthly revenue at the end of the day, base currency only.', source: 'DailyRevenueRollup.mrrCents' },
  { key: 'mrr_movement', product: 'financial', label: 'MRR movement', kind: 'cents', definition: 'New, expansion, contraction, churned and reactivation MRR on the day, from subscription events.', source: 'DailyRevenueRollup.newMrrCents' },
  { key: 'subscribers', product: 'financial', label: 'Subscribers', kind: 'snapshot', definition: 'Active subscriptions at the end of the day, reconstructed from events; the trialing, past-due and canceled counts are the sweep-day snapshot and are read from the latest row, stated with its day.', source: 'DailyRevenueRollup.activeSubscriptions' },
  { key: 'cash', product: 'financial', label: 'Cash', kind: 'cents', definition: 'Invoiced, paid, refunded, fees and net on the day, per currency, never summed across currencies.', source: 'DailyRevenueRollup.paidCents' },
  { key: 'payment_outcomes', product: 'financial', label: 'Payment outcomes', kind: 'count', definition: 'Payments succeeded, failed and pending on the day, per currency.', source: 'DailyRevenueRollup.paymentsSucceeded' },
  { key: 'logo_churn', product: 'financial', label: 'Logo churn', kind: 'rate', definition: 'Customers churned in the period over customers at its start.', source: 'DailyRevenueRollup.churnedCustomers' },
  { key: 'cohort_retention', product: 'financial', label: 'Cohort retention', kind: 'rate', definition: 'Subscribers who started in a month and were still alive N months later, over the cohort size, per currency.', source: 'SubscriptionCohortMart.retained' },
  // --- AI cost -----------------------------------------------------------------
  { key: 'ai_runs', product: 'ai', label: 'AI runs', kind: 'count', definition: 'Gateway runs recorded that day, every provider including deterministic.', source: 'DailyMetric.ai_runs' },
  { key: 'ai_refused', product: 'ai', label: 'AI refusals', kind: 'count', definition: 'Gateway runs recorded as refused that day (policy or a restricted key).', source: 'DailyMetric.ai_refused' },
  { key: 'ai_cost_cents', product: 'ai', label: 'AI cost', kind: 'cents', definition: 'Provider cost recorded on the day\'s runs, in cents; zero for the deterministic engine.', source: 'DailyMetric.ai_cost_cents' },
  // --- connector health ------------------------------------------------------------
  { key: 'connector_runs', product: 'connectors', label: 'Connector runs', kind: 'count', definition: 'Job-source runs started that day.', source: 'DailyMetric.connector_runs' },
  { key: 'connector_failures', product: 'connectors', label: 'Connector failures', kind: 'count', definition: 'Job-source runs started that day whose status is failed or refused.', source: 'DailyMetric.connector_failures' },
  { key: 'jobs_captured', product: 'connectors', label: 'Jobs captured', kind: 'count', definition: 'Canonical jobs created by runs started that day.', source: 'DailyMetric.jobs_captured' },
  // --- career transition ---------------------------------------------------------------
  { key: 'career_plans_created', product: 'career', label: 'Career plans created', kind: 'count', definition: 'Career plans created that day with no predecessor.', source: 'DailyMetric.career_plans_created' },
  { key: 'career_plans_refreshed', product: 'career', label: 'Career plans refreshed', kind: 'count', definition: 'Career plan versions created that day that supersede an earlier version.', source: 'DailyMetric.career_plans_refreshed' },
  // --- employer (per organisation) --------------------------------------------------------
  { key: 'submissions', product: 'employer', label: 'Submissions', kind: 'count', definition: 'Submissions created that day, attributed to their creation day; cut by source.', source: 'OrganizationDailyMart.employer.submissions' },
  { key: 'consented', product: 'employer', label: 'Consented', kind: 'count', definition: 'Submissions created that day that reached consented at any point.', source: 'OrganizationDailyMart.employer.consented' },
  { key: 'screening', product: 'employer', label: 'Screening', kind: 'count', definition: 'Submissions created that day that reached screening at any point.', source: 'OrganizationDailyMart.employer.screening' },
  { key: 'interviewing', product: 'employer', label: 'Interviewing', kind: 'count', definition: 'Submissions created that day that reached interviewing at any point.', source: 'OrganizationDailyMart.employer.interviewing' },
  { key: 'offered', product: 'employer', label: 'Offered', kind: 'count', definition: 'Submissions created that day that reached offered at any point.', source: 'OrganizationDailyMart.employer.offered' },
  { key: 'hired', product: 'employer', label: 'Hired', kind: 'count', definition: 'Submissions created that day that reached hired at any point; cut by source.', source: 'OrganizationDailyMart.employer.hired' },
  { key: 'rejected', product: 'employer', label: 'Rejected', kind: 'count', definition: 'Submissions created that day that reached rejected at any point.', source: 'OrganizationDailyMart.employer.rejected' },
  { key: 'withdrawn', product: 'employer', label: 'Withdrawn', kind: 'count', definition: 'Submissions created that day that reached withdrawn at any point.', source: 'OrganizationDailyMart.employer.withdrawn' },
  { key: 'stage_moves', product: 'employer', label: 'Stage moves', kind: 'count', definition: 'Stage transitions on the day by an organisation MEMBER; cut by recruiter (member id). Candidate-driven events are excluded.', source: 'OrganizationDailyMart.employer.stage_moves' },
  { key: 'days_to_screening', product: 'employer', label: 'Days to shortlist', kind: 'count', definition: 'Sum of whole days from creation to first screening over submissions created that day (valueInt), with the count of such submissions (people) - the page derives the mean; a median is not a mart quantity and is stated as a mean.', source: 'OrganizationDailyMart.employer.days_to_screening' },
  { key: 'days_to_interviewing', product: 'employer', label: 'Days to interview', kind: 'count', definition: 'As days_to_screening, to first interviewing.', source: 'OrganizationDailyMart.employer.days_to_interviewing' },
  { key: 'days_to_hired', product: 'employer', label: 'Days to hire', kind: 'count', definition: 'As days_to_screening, to first hired.', source: 'OrganizationDailyMart.employer.days_to_hired' },
  // --- staffing (per organisation) ----------------------------------------------------------
  { key: 'engagements_opened', product: 'staffing', label: 'Engagements opened', kind: 'count', definition: 'Engagements created that day; cut by recruiter (owner).', source: 'OrganizationDailyMart.staffing.engagements_opened' },
  { key: 'representations_requested', product: 'staffing', label: 'Representations requested', kind: 'count', definition: 'Representation requests made that day; cut by recruiter (requester).', source: 'OrganizationDailyMart.staffing.representations_requested' },
  { key: 'representations_granted', product: 'staffing', label: 'Representations granted', kind: 'count', definition: 'Requests made that day whose status is granted; cut by recruiter (requester).', source: 'OrganizationDailyMart.staffing.representations_granted' },
  { key: 'placements', product: 'staffing', label: 'Placements', kind: 'count', definition: 'Placements created that day; cut by recruiter (credited).', source: 'OrganizationDailyMart.staffing.placements' },
  { key: 'placements_fell_off_in_guarantee', product: 'staffing', label: 'Fell off in guarantee', kind: 'count', definition: 'Placements created that day whose status is fell_off with a fall-off date inside the guarantee; cut by recruiter.', source: 'OrganizationDailyMart.staffing.placements_fell_off_in_guarantee' },
  { key: 'placement_fee_cents', product: 'staffing', label: 'Placement fees', kind: 'cents', definition: 'Frozen fees of placements created that day, in cents; cut by recruiter. Read by finance and admin only.', source: 'OrganizationDailyMart.staffing.placement_fee_cents' },
  { key: 'invoices_issued', product: 'staffing', label: 'Placement invoices issued', kind: 'cents', definition: 'Placement invoices issued that day: count (valueInt) and amount (valueCents).', source: 'OrganizationDailyMart.staffing.invoices_issued' },
  { key: 'invoices_paid', product: 'staffing', label: 'Placement invoices paid', kind: 'cents', definition: 'Placement invoices marked paid that day: count and amount.', source: 'OrganizationDailyMart.staffing.invoices_paid' },
  { key: 'invoices_credited', product: 'staffing', label: 'Guarantee credits', kind: 'cents', definition: 'Placement invoices credited (guarantee) that day: count and credited amount, attributed to the invoice\'s issue day.', source: 'OrganizationDailyMart.staffing.invoices_credited' },
  // --- cases / employment outcome (per organisation; suppressed under five clients) -----------
  { key: 'cases_opened', product: 'cases', label: 'Cases opened', kind: 'count', definition: 'Cases opened (openedAt) that day. No cut: a caseload cut by anything could re-identify a client.', source: 'OrganizationDailyMart.cases.cases_opened' },
  { key: 'cases_closed', product: 'cases', label: 'Cases closed', kind: 'count', definition: 'Cases closed (closedAt) that day.', source: 'OrganizationDailyMart.cases.cases_closed' },
  { key: 'outcomes', product: 'cases', label: 'Employment outcomes', kind: 'count', definition: 'Outcomes recorded that day; cut by kind (employed, self_employed, training, other). people is the distinct clients behind that day\'s row, and a day under five clients is withheld from every range that includes it.', source: 'OrganizationDailyMart.cases.outcomes' },
  { key: 'follow_ups_due', product: 'cases', label: 'Follow-ups due', kind: 'count', definition: 'Retention follow-ups due that day.', source: 'OrganizationDailyMart.cases.follow_ups_due' },
  { key: 'follow_ups_completed', product: 'cases', label: 'Follow-ups completed', kind: 'count', definition: 'Retention follow-ups due that day that were completed.', source: 'OrganizationDailyMart.cases.follow_ups_completed' },
];

export const PLATFORM_METRIC_KEYS: readonly string[] = PLATFORM_METRIC_DICTIONARY.map((m) => m.key);

export function platformMetric(key: string): PlatformMetricDefinition {
  const found = PLATFORM_METRIC_DICTIONARY.find((m) => m.key === key);
  if (!found) throw new Error(`Unknown platform metric: ${key}`);
  return found;
}

/** ADR-0012: a small cohort is never a number. Shared with the candidate benchmark. */
export const MIN_ORG_COHORT = 5;
