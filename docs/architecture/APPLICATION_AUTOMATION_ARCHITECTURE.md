# Application Automation Architecture

**Decision:** `../adr/ADR-0016-application-automation.md`

## Posture
**Human-in-the-loop is the default and the only shipped mode.**

| Mode | Behaviour | Status |
| --- | --- | --- |
| Recommend Only | Surface matches; no documents generated | Available |
| Prepare | Generate tailored documents; nothing sent | Available |
| Review & Submit | Prepare, candidate reviews and confirms | Available — **default** |
| Approved Auto-Apply | Submit within approved parameters | **Modelled, disabled, unreachable** (Stage 22) |

## Channels (implemented)
- **`ats_api`** — programmatic submission, only where an **employer** has issued a
  credential for their own board (Greenhouse, Lever). This is the only case where
  automation is unambiguously authorized.
- **`assisted`** — everything prepared; the candidate confirms on the employer's
  own form. Prepared fields are one-click copyable and are the contract a future
  browser extension consumes.
- **`unavailable`** — nothing could be prepared; documents are still saved.

## Why assisted, not automated
Quoted from the existing source (`src/lib/providers/apply/types.ts`), which got
this right:

> The major aggregators prohibit automated submission in their terms, and they
> enforce it against the *applicant's* account. A product that quietly drives
> those forms is spending its customers' accounts to manufacture a metric.

The candidate loses one click. They keep the account their job search depends on.

## Known defect to fix in Stage 00
`agent-form.tsx` renders an **"Auto-apply above N%"** toggle. `scanner.ts` uses
the threshold only to increment a counter. No scheduler exists. A candidate can
enable it and reasonably believe applications are being sent.

**Remediation: disable or clearly relabel the control.** This is a UI honesty
fix, not an implementation of auto-apply.

## Question policy enforcement (Stage 03)
Reusable answers are classified by risk and carry a policy state:

| Policy | Behaviour |
| --- | --- |
| `AUTO_FILL` | Filled without prompting |
| `ASK_IF_CHANGED` | Filled; confirmation requested if the stored answer is stale |
| `REQUIRE_REVIEW` | Presented for explicit confirmation every time |
| `NEVER_AUTOMATE` | Always answered by a human, **in every mode** |

Sensitive and demographic questions default to `NEVER_AUTOMATE`.

## Quota and integrity
The existing pattern is preserved: quota is reserved for the whole batch up front,
and any unused portion is refunded — a job already applied to, or one whose
submission failed, never consumes an application from the plan.

## Absolute prohibitions
No CAPTCHA bypass. No access-control circumvention. No browser-fingerprint
evasion. No proxy infrastructure whose purpose is defeating restrictions. These
hold in every mode, including any future autonomous mode.
