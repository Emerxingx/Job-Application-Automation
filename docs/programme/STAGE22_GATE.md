# Stage 22 - Controlled autonomous application capability - the gate record

**Status: BLOCKED BY DESIGN. Nothing was built. Nothing will be built until every
precondition below is met in writing and a founder decision is recorded.**

Recorded 2026-09-05 on branch `claude/stage-22-autonomous-gate` (stacked on Stage
21). This stage's deliverable is not code: it is the record of the gate, of the
proof that the gate holds today, and of exactly what would have to be true before
any design work begins. `MASTER_BUILD_PLAN.md` Stage 22, ADR-0016, ADR-0026.

## 1. What the platform does today, proven

| Property | Where it is enforced | Where it is proven |
| --- | --- | --- |
| Three reachable application modes: `recommend_only`, `prepare`, `review_and_submit`; the fourth, `approved_auto_apply`, is named only so it can be refused | `src/lib/apply/modes.ts` (`UNREACHABLE_MODE`, `parseApplicationMode` refuses it; no permission row exists) | `tests/application-modes.test.ts` |
| Every apply provider's `apply()` PREPARES and returns `assisted` or `unavailable`; none submits, even with an employer credential, even the mock | `src/lib/providers/apply/*` (ADR-0026) | Stage 12 provider tests |
| A record becomes `submitted` only through the applicant's own action: `confirmAssistedSubmission` (they did it on the form) or `submitThroughAts` (their instructed click, Review & submit mode, an employer-authorised board) | `src/lib/apply/` | Stage 12 and Stage 14 tests (`confirm` and `submit` under the same advisory lock) |
| The auto-apply control is disabled in the UI and the README says so; `autoApplyThreshold` is read only to increment a counter; no scheduler exists (`AgentSchedule` has no reader) | Stage 00 | `CLAUDE.md` item 4; the scanner source |
| No CAPTCHA bypass, no access-control circumvention, no fingerprint evasion, no restriction-defeating proxy anywhere; an `AtsRuleset` cannot carry an evasion setting | `docs/governance/SOURCE_ACCESS_POLICY.md`, ADR-0008 | Stage 05 static tests |
| A job source runs only through `requireEnabledSource()` with a recorded legal basis; only the synthetic mock is enabled | Stage 05, ADR-0008 | Stage 05 tests |

No pull request in this programme adds a path from a scheduled or automatic
trigger to a submission. The static tests above are the mechanism that keeps it
that way; a change to any of them is a change to this gate and needs the
founder decision below first.

## 2. Preconditions - every one NOT MET

The plan lists them; each is restated here with its current status so that the
record cannot be read as partial progress.

| # | Precondition (MASTER_BUILD_PLAN Stage 22) | Status | What would satisfy it |
| --- | --- | --- | --- |
| P1 | Per-source lawfulness confirmed in writing | **NOT MET** | Counsel's written confirmation, per job source, that automated submission is permitted by that source's terms and by law in the target jurisdiction; recorded on the `JobSource` register row with the citation (L-3 / SOURCE_ACCESS_POLICY). Today every credentialed source is disabled and the mock is the only enabled one; there is nothing to confirm yet. |
| P2 | Explicit, revocable, granular candidate consent | **NOT MET** | A consent purpose for autonomous submission (per source, per application ceiling, per period) with counsel-approved wording, following the Stage 17-19 consent pattern (one transaction, `ConsentRecord`, withdrawal that stops everything in flight). No such purpose exists and no `-draft` wording has been written. |
| P3 | Hard eligibility gating | **PRECONDITION EXISTS, NOT WIRED TO AUTONOMY** | Stage 07's engine is the gate for any future path; an `ineligible` verdict would have to refuse an autonomous submission before preparation, and `unknown` would have to refuse too (autonomy cannot inherit the "unknown never excludes" rule that is right for a human). Nothing reads it for that purpose because no such path exists. |
| P4 | Evidence grounding enforced | **PRECONDITION EXISTS, NOT WIRED TO AUTONOMY** | Stage 03's gateway grounds every generated section in the résumé and approved evidence; an autonomous path would additionally need a refusal, not a degrade, when grounding fails. |
| P5 | Per-application audit with human-reversible actions | **NOT MET** | Every autonomous action would need an audit row before it, a withdrawal path on the employer side where one exists, and a visible record the applicant can act on. Withdrawal after submission is not something the platform can promise for a third-party board; this is a design question for counsel and the founder, not an engineering item. |
| P6 | Kill switch | **NOT MET** | A platform-wide and per-tenant stop that is Tier-2 (code and migration, never a feature flag - ADR-0019, ADR-0035 `isTierTwoKey`), checked before every autonomous action and honoured mid-batch. |
| P7 | Volume caps | **NOT MET** | Per applicant, per source, per day and per period ceilings as entitlements (Stage 15), never as a plan column; a cap reached refuses, it does not queue. |
| P8 | Full terms-of-service compliance | **NOT MET** | Follows P1; includes rate and identity requirements the source states. |
| P9 | Explicit written founder decision | **NOT MET** | A dated, signed decision recorded in `docs/governance/DECISION_REGISTER.md` naming the sources, the consent wording version and the caps approved. |
| P10 | Legal review | **NOT MET** | Counsel's review of P1, P2, P5 and P8 together, recorded as L-6 in `COMPLIANCE_REGISTER.md`. |

## 3. What this stage explicitly did not do

- No design document for an autonomous path was written; the plan forbids
  design work before the preconditions.
- No schema, model, flag, permission row, provider, scheduler or queue was
  added for it.
- No test was relaxed. The static tests that refuse `approved_auto_apply`, an
  evasion setting and an unregistered source are unchanged.
- The Stage 22 exit gate is therefore **BLOCKED**, as the plan states, and the
  programme continues to Stage 23 with that recorded.

## 4. How the gate would be reopened

Only in this order, each step recorded before the next: P1 and P10 by counsel
-> P2 wording approved -> P9 the founder's decision -> a NEW ADR superseding
ADR-0016's automation policy, reviewed independently -> design under Stage 23's
security review -> implementation on its own stacked branch with P3-P8 proven
by tests before any provider is wired. Any pull request that touches
`src/lib/apply/modes.ts`, an apply provider's `apply()`, `AtsRuleset`, or
`requireEnabledSource()` in the direction of automation without that chain is
out of policy and must be closed.
