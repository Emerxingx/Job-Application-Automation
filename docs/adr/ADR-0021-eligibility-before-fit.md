# ADR-0021 — Eligibility is evaluated before fit, as pass/fail with reasons

**Status:** Accepted (Stage 07, 2026-09-03) · **Implements:** `JOB_INTELLIGENCE_ARCHITECTURE.md` "Eligibility engine (Stage 07) — distinct from scoring" · **Closes:** G-12

## Context

Before Stage 07 the only judgement a candidate saw about a posting was a fit
score. A candidate who needs sponsorship could be shown a 92% match for a
role whose posting says it does not sponsor. The brief mandates hard
eligibility as its own stage, evaluated first, and forbids folding it into a
number.

## Decision

1. **Eligibility runs before scoring, in the scanner.** A posting that fails a
   hard rule never becomes a `JobMatch`. The verdict is stored per (user, job)
   with every rule's status and reason so the exclusion is visible, never
   silent.
2. **Pass / fail / unknown, never a number.** Each rule states a reason in
   words addressed to the candidate. A hard `fail` makes the verdict
   `ineligible`; `unknown` never excludes — silence on either side leaves the
   question open and the posting reaches scoring, flagged.
3. **Only what both sides state.** A rule fails only on a statement the posting
   made (Stage 06's canonical fields, which themselves refuse to infer from
   silence or negation) and a fact the candidate recorded.
4. **Advisory rules are marked advisory.** The canonical job lists the
   certifications and languages a posting mentions without separating
   "required" from "a plus"; gating on a mention would exclude candidates for
   preferences. Until Stage 08's requirement extraction, certification is a
   hard gate only for a licensed designation the title itself demands, and
   language never excludes. The page says "advisory" on those rules.
5. **Jurisdiction is the posting's country.** Canada and the US are modelled;
   any other answers `unknown`.
6. **Work authorisation is access-controlled and audited, not sensitive.** It
   is read on the tenant path, once per batch, after an
   `eligibility.profile.read` audit row that names the purpose and batch size
   and never a value. The engine never touches the sensitive schema
   (ADR-0007); the static allowlist test enforces it.

## Consequences

- The feed, the dashboard and the v1 match feed only ever show postings the
  candidate is eligible for or whose eligibility is unconfirmed; exclusions
  are listed with reasons at `/dashboard/jobs/excluded`.
- A wrong profile fact (an outdated permit expiry) can exclude a posting; the
  reason names the fact and where to fix it, and a profile change re-evaluates
  every stored verdict on the next scan or page view.
- Radius is not implemented (no coordinates exist); security clearance is
  unknown-only (no profile field). Both are stated in the evidence rather than
  approximated.
