# ADR-0027 - Candidate analytics read marts through one metric dictionary, with reach from history, small-cohort suppression and published freshness

**Status:** Accepted (Stage 13, 2026-09-03) · **Implements:** `MASTER_BUILD_PLAN.md` Stage 13; ADR-0012 stage 1 ("now") · **Depends on:** ADR-0024 (folder, status history), ADR-0011 (event bus - NOT built; the marts are rebuilt by replacement, not fed incrementally)

## Context

The candidate dashboards computed their numbers from the transactional
tables on every page load (`loadApplicationMetrics`, six `count`s on the
overview), inferred the funnel from the CURRENT status only (an interview
followed by a rejection vanished), and nothing defined a metric in one place
- the analytics page, the overview and the export each had their own
reading of "sent". ADR-0012 requires marts, one definition per metric,
small-cohort suppression and published freshness.

## Decision

1. **One dictionary.** `src/lib/analytics/candidate/dictionary.ts` names
   every candidate metric once - key, label, a definition in a candidate's
   words, and the mart column it reads - with the one function that computes
   a rate (`rateOf`) and a value (`valueOf`). `docs/governance/METRIC_DICTIONARY.md`
   is its human copy and a test fails when they differ. Dashboards may not
   compute a variant.
2. **Reach from history.** Counts are cumulative reach inferred from
   `ApplicationStatusHistory` plus the current status: an application that
   ever stood at `interviewing` is an interview, whatever happened after.
   Attribution is the record's creation day, so a period's numbers never
   move because of later events.
3. **Three marts, replaced not incremented.** `CandidateOutcomeMart`
   (user, day, dimension, key), `CandidateMatchMart` (user, day) and
   `CandidateBenchmarkMart` (day, dimension, key, distinct users). The rollup
   is the only reader of the transactional tables; it rewrites whole
   (days × user) scopes inside a transaction and records a `RollupRun`.
   The first two are user-owned under RLS and read on the tenant path; the
   benchmark carries no user id, is system-only, and is read only through
   the suppression rule.
4. **Dashboards read marts.** The analytics page and the overview's three
   numbers read the marts on the tenant path; a static test fails if either,
   or the read module, queries a transactional table. The overview's two
   LISTS (top matches, recent activity) are operational reads of the
   candidate's own rows, not metrics, and are outside this rule - stated.
5. **Small-cohort suppression.** A benchmark cut with fewer than five
   distinct people yields no number and says why. Over a range the rule is
   applied per day before summing, so a single person's day is never folded
   into a shown total; the cohort reported is the smallest included day's.
6. **Freshness is published.** Every dashboard shows the last successful
   rebuild and flags one older than a day. Rebuilds: the operator's sweep,
   the candidate's rate-limited refresh of their own rows, and once on a
   first visit (`User.analyticsBuiltAt` null). All three marts are rewritten
   in one transaction under an advisory lock on the scope; a candidate's
   refresh rebuilds the benchmark only for the days their rows touched.
   There is no scheduler.
7. **Not available, stated.** There is no industry dimension (no industry
   classification exists). The marts are not fed incrementally from an event
   stream (ADR-0012 stage 2 waits on ADR-0011). The export endpoint still
   reads the transactional rows: it is a data export, not a dashboard, and is
   named as such.

## Consequences

- Two definitions of "response rate" cannot exist: the page, the overview
  and the parity test all call the same function.
- A dashboard load is an indexed scan of the candidate's mart rows; the
  transactional tables are read once per rebuild.
- The mart says more than the old engine could (interviews later rejected,
  screens, hires, time to reply) and the parity test records exactly where
  and why the two differ.
- A stale dashboard says so; a silent night is a `RollupRun` gap, not a
  quiet chart.
