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
says why. Over a range, the cohort is the LARGEST single-day cohort - the
conservative reading, which can only understate it. The benchmark table has
no user id and is never read on the tenant path.

## Freshness

Marts are rebuilt by the operator's sweep (`npm run analytics:rollup`), by the
candidate's own "Refresh" (their rows only, rate-limited), and once on a
candidate's first visit when their marts hold nothing. There is no
scheduler (ADR-0011 is not built). Every dashboard shows the time of the
last successful rebuild and says when it is more than a day old.
