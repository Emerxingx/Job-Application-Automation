# ADR-0016 — Application automation and human approval policy

**Status:** Proposed · **Date:** 2026-09-02

## Context
The existing implementation already made the right call, and documented it well.
`src/lib/providers/apply/types.ts` states the reasoning in the source:

> The major aggregators (LinkedIn, Indeed and most employer portals behind them)
> prohibit automated submission in their terms, and they enforce it against the
> *applicant's* account. A product that quietly drives those forms is spending its
> customers' accounts to manufacture a metric.

Three providers exist: `DefaultApplyProvider` (authorized ATS API where
available, assisted elsewhere), `AssistedOnlyApplyProvider`, and
`MockApplyProvider` (simulated, never contacts an employer, never claims a real
confirmation).

**Measured current state:** nothing applies autonomously. `applyToJobs` is
reachable only from an authenticated, rate-limited, user-initiated route. No
scheduler exists; `AgentSchedule` has zero code references.

**But there is a product-integrity defect.** `agent-form.tsx` renders an
"Auto-apply above N%" toggle. `scanner.ts` uses the threshold only to increment a
counter. A user can enable it and reasonably believe applications are being sent.

## Decision
**Human-in-the-loop is the default and the only shipped mode.**

Four modes are modelled; only the first three are reachable:

| Mode | Status |
| --- | --- |
| Recommend Only | Available |
| Prepare | Available |
| Review & Submit | Available (default) |
| Approved Auto-Apply | **Modelled, disabled, unreachable** until Stage 22 |

**Immediate action (Stage 00):** the auto-apply toggle is disabled or relabelled
so no UI control promises behaviour that does not exist. This is a UI honesty fix,
**not** an implementation of auto-apply.

**Preconditions before autonomy is even designed** (Stage 22, `BLOCKED`):
per-source lawfulness confirmed in writing; explicit, granular, revocable
candidate consent; hard eligibility gating (Stage 07); evidence grounding
enforced (Stage 03); per-application audit with human-reversible actions; a kill
switch; volume caps; and an explicit written founder decision plus legal review.

**Never, under any mode:** CAPTCHA bypass, access-control circumvention,
fingerprint evasion, or proxy infrastructure intended to defeat restrictions.

## Consequences
- Programmatic submission happens only where an **employer** has issued a
  credential for their own board. That is the only case where automation is
  unambiguously authorized.
- The assisted path must be genuinely excellent — prepared fields, one-click
  copy, an optional browser extension. The product's value is the tailoring, the
  folder and the tracking, not the click.
- `NEVER_AUTOMATE` questions (Stage 03) always require a human, in every mode.
- Marketing may not describe the product as "auto-apply" while this ADR stands.

## Revisit when
The Stage 22 preconditions are met and the founder makes an explicit, documented,
legally-reviewed decision.
