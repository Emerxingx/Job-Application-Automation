# Metric dictionary - candidate analytics

**Authority:** `src/lib/analytics/candidate/dictionary.ts` (Stage 13, ADR-0012 rule 1, ADR-0027).
This page is the human copy of that table. A test (`tests/candidate-marts.test.ts`)
fails when a key, a label or a definition here differs from the code, so the two
cannot drift. Dashboards may not compute their own variants: every number a
candidate sees is one of these, computed by the one function beside its definition.

## How to read a definition

Counts are **cumulative reach**, inferred from the application's status
**history** plus its current status - never from the current status alone. An
application that interviewed and was then rejected is still one interview.
So the funnel decreases monotonically and every rate's denominator is its
parent stage. A rate with a zero denominator is `0` with `denominator: 0`;
it is never `NaN` and never hidden.

Attribution: an application belongs to the **day its record was created**
(UTC). Its later moves stay on that day - a July application that interviews
in September is a July interview - so a period's numbers never change because
of what happened after it.

Source: every metric reads a **mart** (`CandidateOutcomeMart`,
`CandidateMatchMart`, `CandidateBenchmarkMart`), never a transactional table.
The rollup (`src/lib/analytics/candidate/rollup.ts`) is the only reader of the
transactional tables, and it replaces whole days rather than incrementing.

## Counts

| Key | Label | Definition | Source |
| --- | --- | --- | --- |
| `applications` | Applications | Applications created in the period, attributed to the day the record was created - prepared or not, sent or not. | `CandidateOutcomeMart.applications` |
| `sent` | Sent | Applications that reached the employer: the record reached at least `submitted` (confirmed by you, or submitted on your instruction). | `CandidateOutcomeMart.sent` |
| `responded` | Employer replied | Sent applications where an employer responded: a response was recorded, or the record reached interviewing, offer or rejected. | `CandidateOutcomeMart.responded` |
| `screens` | Phone screens | Applications with at least one interview of kind `phone` recorded in the folder. | `CandidateOutcomeMart.screens` |
| `interviews` | Interviews | Applications that reached at least `interviewing` at any point (an offer counts, whatever the status is today). | `CandidateOutcomeMart.interviews` |
| `offers` | Offers | Applications that reached `offer` at any point. | `CandidateOutcomeMart.offers` |
| `hires` | Hires | Applications whose recorded outcome is `hired` (an offer you accepted). | `CandidateOutcomeMart.hires` |
| `rejected` | Rejected | Applications whose current status is `rejected`. | `CandidateOutcomeMart.rejected` |
| `withdrawn` | Withdrawn | Applications whose current status is `withdrawn`. | `CandidateOutcomeMart.withdrawn` |
| `ghosted` | Ghosted | Applications whose recorded outcome is `ghosted` - sent, never answered, closed by you. | `CandidateOutcomeMart.ghosted` |
| `expired` | Expired | Applications whose recorded outcome is `expired` - the posting closed before a decision. | `CandidateOutcomeMart.expired` |
| `failed` | Failed | Applications whose current status is `failed` - the preparation or a submission errored; nothing reached the employer. | `CandidateOutcomeMart.failed` |

## Rates

| Key | Label | Definition | Source |
| --- | --- | --- | --- |
| `response_rate` | Response rate | Employer replied divided by Sent. | `CandidateOutcomeMart.responded / sent` |
| `screen_rate` | Screen rate | Phone screens divided by Sent. | `CandidateOutcomeMart.screens / sent` |
| `interview_rate` | Interview rate | Interviews divided by Sent. | `CandidateOutcomeMart.interviews / sent` |
| `offer_rate` | Offer rate | Offers divided by Sent. | `CandidateOutcomeMart.offers / sent` |
| `hire_rate` | Hire rate | Hires divided by Sent. | `CandidateOutcomeMart.hires / sent` |
| `interview_from_response` | Interviews per reply | Interviews divided by Employer replied - how many replies become a conversation. | `CandidateOutcomeMart.interviews / responded` |
| `offer_from_interview` | Offers per interview | Offers divided by Interviews - how many conversations become an offer. | `CandidateOutcomeMart.offers / interviews` |

## Values

| Key | Label | Definition | Source |
| --- | --- | --- | --- |
| `average_match_score` | Average match score | Mean compatibility score of the applications counted, one decimal; 0 when there are none. | `CandidateOutcomeMart.sumMatchScore / applications` |
| `average_response_hours` | Average time to first reply | Mean hours from sending to the first employer response, over applications that have both; an unanswered application is not counted as zero. | `CandidateOutcomeMart.sumResponseHrs / responseSamples` |

## Dimensions (cuts)

Every count above exists per dimension key; the `all` row is the undimensioned total,
and on any day the keys of every other dimension sum to it (tested).

| Dimension | Key | Note |
| --- | --- | --- |
| `all` | `all` | The total. |
| `title` | the canonical job title, lower-cased | Stage 06 `normalizedTitle`, or the posting's title. |
| `company` | the company, lower-cased | |
| `seniority` | intern · junior · intermediate · senior · lead · manager · director · executive · unspecified | Read from the title's own words (`seniorityOf`); the only place a posting says it. |
| `geography` | `<country>:<city or region>` | The first segment of the posting's location. |
| `source` | the job source name | Stage 05 register name. |
| `resume_version` | `v<n>` or `none` | The tailored resume's `DocumentVersion.version` used for the application. |
| `score_band` | `0-49` · `50-69` · `70-84` · `85-100` | Compatibility score bands, closed at the top. |

**`industry` is not a dimension.** No industry classification exists in the
platform (NOC is occupation, not industry); the plan's "industry" cut is
NOT AVAILABLE and is stated rather than approximated.

## Benchmarks and small-cohort suppression

`CandidateBenchmarkMart` holds the same counts per (day, dimension, key)
across every candidate, with `users` = the number of DISTINCT people in the
cut. The read path (`readBenchmark`) applies one rule before anything leaves
it: a cut with fewer than **5** people (`MIN_COHORT`) yields no number and
says why. Over a range the rule is applied PER DAY before anything is
summed: a day under the threshold contributes nothing, so one person's
outcome can never be isolated by differencing two overlapping ranges; the
cohort reported is the smallest included day's, a lower bound. The
benchmark table has no user id and is never read on the tenant path.

## Freshness

Marts are rebuilt by the operator's sweep (`npm run analytics:rollup`), by the
candidate's own "Refresh" (their rows only, rate-limited), and once on a
candidate's first visit when their marts hold nothing. There is no
scheduler (ADR-0011 is not built). Every dashboard shows the time of the
last successful rebuild and says when it is more than a day old.

---

# Metric dictionary - platform, financial and organisation reporting (Stage 21, ADR-0036)

Mirrors `src/lib/analytics/platform/dictionary.ts` (`PLATFORM_METRIC_DICTIONARY`);
`tests/reporting-static.test.ts` fails when a key, a definition, a mart or an SLA
differs. The same rule as above: one definition per metric, every metric names
the MART it is read from, and no dashboard computes its own variant. A staff or
organisation page reads a mart through `src/lib/analytics/{platform,organization,finance}/`
and never a transactional table; the operational queues on the console overview
(`console/queues.ts`) are lists, not metrics, and the static test refuses a count in them.

## Marts and refresh SLAs

| Mart | Scope (RLS) | Partition | Rebuilt by | SLA | Holds |
| --- | --- | --- | --- | --- | --- |
| `DailyMetric` | system | `day` | `daily_metrics`, `platform_metrics` | 26h | Platform-wide daily counts and end-of-day snapshots (signups, activity, AI runs and cost, connector runs, open tickets, overdue invoices). |
| `DailyRevenueRollup` | system | `day` | `daily_revenue` | 26h | One wide finance row per day per currency: cash, MRR and its movement, subscriber counts, payment outcomes. |
| `SubscriptionCohortMart` | system | `day` | `subscription_cohorts` | 26h | Subscriber retention by start month and month offset, per currency. |
| `OrganizationDailyMart` | org | `day` | `organization_reporting` | 26h | Per-organisation product facts by day: employer funnel and sources, staffing productivity, case outcomes. |
| `CandidateOutcomeMart` | user | `day` | `candidate_outcomes` | 26h | Stage 13: the candidate's own application outcomes by dimension. |
| `CandidateMatchMart` | user | `day` | `candidate_outcomes` | 26h | Stage 13: the candidate's match score bands and keywords by day. |
| `CandidateBenchmarkMart` | system | `day` | `candidate_outcomes` | 26h | Stage 13: the platform benchmark, suppressed under five people. |

A page shows the instant its mart was last rebuilt (the OLDEST of the latest succeeded `RollupRun`
per job that writes it) and says **STALE** past the SLA rather than showing old numbers
silently. There is no scheduler: `npm run analytics:rollup` rebuilds every mart
(`rollupAll`), and staleness is the operator's cue.

Snapshot metrics (`kind: snapshot`) are point-in-time: they are written for the
as-of day of the run only and never backfilled, because what was open on a past
day cannot be reconstructed from today's state.

## Founder / platform

| Key | Label | Kind | Definition | Source |
| --- | --- | --- | --- | --- |
| `signups` | Signups | count | Accounts created that day (UTC). | `DailyMetric.signups` |
| `applications_submitted` | Applications submitted | count | Applications whose appliedAt falls on the day. | `DailyMetric.applications_submitted` |
| `active_users` | Active users | distinct | Distinct accounts with any usage event that day. | `DailyMetric.active_users` |
| `organizations_verified` | Organisations verified | count | Organisations staff verified that day (verifiedAt). | `DailyMetric.organizations_verified` |
| `sso_sign_ins` | SSO sign-ins | count | Successful sign-ins through an organisation's SSO that day (audit rows auth.sso.succeeded). | `DailyMetric.sso_sign_ins` |
| `active_organizations` | Active organisations | snapshot | Non-personal organisations with status active at the end of the as-of day. | `DailyMetric.active_organizations` |
| `live_sessions` | Live sessions | snapshot | Sessions neither revoked nor expired at the end of the as-of day. | `DailyMetric.live_sessions` |
| `open_tickets` | Open support tickets | snapshot | Tickets whose status is open, pending or on_hold at the end of the as-of day. | `DailyMetric.open_tickets` |
| `breached_tickets` | Tickets past SLA | snapshot | Open tickets flagged breachedSla at the end of the as-of day. | `DailyMetric.breached_tickets` |

## Financial

| Key | Label | Kind | Definition | Source |
| --- | --- | --- | --- | --- |
| `failed_payments` | Failed payments | count | Payments that failed that day (failedAt), any currency. | `DailyMetric.failed_payments` |
| `overdue_invoices` | Overdue invoices | snapshot | Open invoices past their due date at the end of the as-of day. | `DailyMetric.overdue_invoices` |
| `overdue_invoice_cents` | Overdue amount | snapshot | Amount due on overdue open invoices at the end of the as-of day, in cents, any currency (a count of money owed, not a sum to be converted). | `DailyMetric.overdue_invoice_cents` |
| `mrr` | Monthly recurring revenue | cents | Normalised contracted monthly revenue at the end of the day, base currency only. | `DailyRevenueRollup.mrrCents` |
| `mrr_movement` | MRR movement | cents | New, expansion, contraction, churned and reactivation MRR on the day, from subscription events. | `DailyRevenueRollup.newMrrCents` |
| `subscribers` | Subscribers | snapshot | Active, trialing, past-due and canceled subscriptions at the end of the day. | `DailyRevenueRollup.activeSubscriptions` |
| `cash` | Cash | cents | Invoiced, paid, refunded, fees and net on the day, per currency, never summed across currencies. | `DailyRevenueRollup.paidCents` |
| `payment_outcomes` | Payment outcomes | count | Payments succeeded, failed and pending on the day, per currency. | `DailyRevenueRollup.paymentsSucceeded` |
| `logo_churn` | Logo churn | rate | Customers churned in the period over customers at its start. | `DailyRevenueRollup.churnedCustomers` |
| `cohort_retention` | Cohort retention | rate | Subscribers who started in a month and were still alive N months later, over the cohort size, per currency. | `SubscriptionCohortMart.retained` |

## AI cost

| Key | Label | Kind | Definition | Source |
| --- | --- | --- | --- | --- |
| `ai_runs` | AI runs | count | Gateway runs recorded that day, every provider including deterministic. | `DailyMetric.ai_runs` |
| `ai_refused` | AI refusals | count | Gateway runs recorded as refused that day (policy or a restricted key). | `DailyMetric.ai_refused` |
| `ai_cost_cents` | AI cost | cents | Provider cost recorded on the day's runs, in cents; zero for the deterministic engine. | `DailyMetric.ai_cost_cents` |

## Connector health

| Key | Label | Kind | Definition | Source |
| --- | --- | --- | --- | --- |
| `connector_runs` | Connector runs | count | Job-source runs started that day. | `DailyMetric.connector_runs` |
| `connector_failures` | Connector failures | count | Job-source runs started that day whose status is failed or refused. | `DailyMetric.connector_failures` |
| `jobs_captured` | Jobs captured | count | Canonical jobs created by runs started that day. | `DailyMetric.jobs_captured` |

## Career transition

| Key | Label | Kind | Definition | Source |
| --- | --- | --- | --- | --- |
| `career_plans_created` | Career plans created | count | Career plans created that day with no predecessor. | `DailyMetric.career_plans_created` |
| `career_plans_refreshed` | Career plans refreshed | count | Career plan versions created that day that supersede an earlier version. | `DailyMetric.career_plans_refreshed` |

## Employer (per organisation)

| Key | Label | Kind | Definition | Source |
| --- | --- | --- | --- | --- |
| `submissions` | Submissions | count | Submissions created that day, attributed to their creation day; cut by source. | `OrganizationDailyMart.employer.submissions` |
| `consented` | Consented | count | Submissions created that day that reached consented at any point. | `OrganizationDailyMart.employer.consented` |
| `screening` | Screening | count | Submissions created that day that reached screening at any point. | `OrganizationDailyMart.employer.screening` |
| `interviewing` | Interviewing | count | Submissions created that day that reached interviewing at any point. | `OrganizationDailyMart.employer.interviewing` |
| `offered` | Offered | count | Submissions created that day that reached offered at any point. | `OrganizationDailyMart.employer.offered` |
| `hired` | Hired | count | Submissions created that day that reached hired at any point; cut by source. | `OrganizationDailyMart.employer.hired` |
| `rejected` | Rejected | count | Submissions created that day that reached rejected at any point. | `OrganizationDailyMart.employer.rejected` |
| `withdrawn` | Withdrawn | count | Submissions created that day that reached withdrawn at any point. | `OrganizationDailyMart.employer.withdrawn` |
| `stage_moves` | Stage moves | count | Stage transitions on the day by an organisation MEMBER; cut by recruiter (member id). Candidate-driven events are excluded. | `OrganizationDailyMart.employer.stage_moves` |
| `days_to_screening` | Days to shortlist | count | Sum of whole days from creation to first screening over submissions created that day (valueInt), with the count of such submissions (people) - the page derives the mean; a median is not a mart quantity and is stated as a mean. | `OrganizationDailyMart.employer.days_to_screening` |
| `days_to_interviewing` | Days to interview | count | As days_to_screening, to first interviewing. | `OrganizationDailyMart.employer.days_to_interviewing` |
| `days_to_hired` | Days to hire | count | As days_to_screening, to first hired. | `OrganizationDailyMart.employer.days_to_hired` |

## Staffing (per organisation)

| Key | Label | Kind | Definition | Source |
| --- | --- | --- | --- | --- |
| `engagements_opened` | Engagements opened | count | Engagements created that day; cut by recruiter (owner). | `OrganizationDailyMart.staffing.engagements_opened` |
| `representations_requested` | Representations requested | count | Representation requests made that day; cut by recruiter (requester). | `OrganizationDailyMart.staffing.representations_requested` |
| `representations_granted` | Representations granted | count | Requests made that day whose status is granted; cut by recruiter (requester). | `OrganizationDailyMart.staffing.representations_granted` |
| `placements` | Placements | count | Placements created that day; cut by recruiter (credited). | `OrganizationDailyMart.staffing.placements` |
| `placements_fell_off_in_guarantee` | Fell off in guarantee | count | Placements created that day whose status is fell_off with a fall-off date inside the guarantee; cut by recruiter. | `OrganizationDailyMart.staffing.placements_fell_off_in_guarantee` |
| `placement_fee_cents` | Placement fees | cents | Frozen fees of placements created that day, in cents; cut by recruiter. Read by finance and admin only. | `OrganizationDailyMart.staffing.placement_fee_cents` |
| `invoices_issued` | Placement invoices issued | cents | Placement invoices issued that day: count (valueInt) and amount (valueCents). | `OrganizationDailyMart.staffing.invoices_issued` |
| `invoices_paid` | Placement invoices paid | cents | Placement invoices marked paid that day: count and amount. | `OrganizationDailyMart.staffing.invoices_paid` |
| `invoices_credited` | Guarantee credits | cents | Placement invoices credited (guarantee) that day: count and credited amount, attributed to the invoice's issue day. | `OrganizationDailyMart.staffing.invoices_credited` |

## Employment services / case outcomes (per organisation)

| Key | Label | Kind | Definition | Source |
| --- | --- | --- | --- | --- |
| `cases_opened` | Cases opened | count | Cases opened (openedAt) that day. No cut: a caseload cut by anything could re-identify a client. | `OrganizationDailyMart.cases.cases_opened` |
| `cases_closed` | Cases closed | count | Cases closed (closedAt) that day. | `OrganizationDailyMart.cases.cases_closed` |
| `outcomes` | Employment outcomes | count | Outcomes recorded that day; cut by kind (employed, self_employed, training, other). Distinct clients in people; suppressed under five. | `OrganizationDailyMart.cases.outcomes` |
| `follow_ups_due` | Follow-ups due | count | Retention follow-ups due that day. | `OrganizationDailyMart.cases.follow_ups_due` |
| `follow_ups_completed` | Follow-ups completed | count | Retention follow-ups due that day that were completed. | `OrganizationDailyMart.cases.follow_ups_completed` |

## Organisation cuts and small-cohort suppression

`OrganizationDailyMart` rows are keyed by (organisation, day, product, metric,
dimension, key). The employer product cuts `submissions` and `hired` by `source`
and `stage_moves` by `recruiter` (the member id); the staffing product cuts
every count and the fee by `recruiter` (`unassigned` when none); the cases
product cuts `outcomes` by `kind` and nothing else, and every outcome row
carries `people` - the distinct clients behind it - so the supervisor's summary
withholds an outcome figure under 5 clients (`MIN_ORG_COHORT`, the same threshold as
the candidate benchmark). Placement fees are read by finance and admin roles only;
a recruiter sees their own row without the fee.

`days_to_*` are sums with the count of submissions behind them; the page derives
a MEAN. A median is not a quantity a daily mart can hold, and the page says "mean".
