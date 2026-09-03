# ADR-0018 — CI and quality gates

**Status:** Proposed · **Date:** 2026-09-02

## Context — measured
| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npm test` | 670 pass / 0 fail, 158 suites |
| `npm run build` | exit 0 |
| `npm run lint` | **exit 1 — interactive ESLint setup prompt** |
| `npm audit` | 14 advisories (6 high) |

**No `.github/workflows/` exists.** Nothing runs on push.

### The lint finding is not what it looked like
`next.config.mjs` sets `eslint: { ignoreDuringBuilds: true }`, which reads as
"lint exists but is skipped." It does not exist:

- No `.eslintrc*`, no `eslint.config.*`.
- ESLint is **not in `package.json`** at all.
- `next lint` therefore prompts interactively and exits non-zero.

The brief said: *do not simply turn lint on if existing lint debt would make
development unmanageable — measure first.* Measurement inverts the concern.
There is **no lint debt**, because lint has never run. The risk is a large
**first-run backlog** on 238 source files, discovered at the worst moment.

## Decision
**Land the gates that already pass as required, immediately. Introduce lint as a
measured, ratcheted gate.**

**Required from Stage 00** (these pass today, so they cost nothing and prevent
regression):
```
install (npm ci) → typecheck → test → build
```

**Reporting-only from Stage 00, blocking later:**
- **ESLint.** Install it, configure `next/core-web-vitals`, run it in CI with
  `continue-on-error`, and **publish the violation count**. Only once the true
  number is known is a remediation plan possible. Then ratchet: fix by rule
  class, and flip each cleaned rule to `error`. Never a blanket enable.
- **`npm audit --audit-level=high`.** Blocking once `ADR-0017` Step 2 lands.
- **Determinism check** for generated files (`ADR-0014`).

**Added as the relevant stages land:** integration tests against a real
PostgreSQL service container (Stage 01), authorization/RLS tests (Stage 01),
contract tests (Stage 14), AI truthfulness evaluation (Stage 03), E2E via
Playwright (Stage 12), accessibility (Stage 23).

**Removed from the interactive path:** `npm run lint` must never prompt. Once
ESLint is configured, `next lint` becomes non-interactive; until then CI must not
invoke it, or the runner will hang.

## Consequences
- `eslint: { ignoreDuringBuilds: true }` stays until the lint backlog is cleared,
  then is removed. Leaving it forever would make the lint gate decorative.
  **Done in Stage 01 (2026-09-02):** the backlog was cleared to 0 errors and lint
  became its own blocking job, so the key had nothing left to suppress. Next 16
  no longer recognises it and warned on every production build, which is what
  surfaced it.
- A `npm run verify` script runs the full local gate set so contributors
  reproduce CI without guessing.
- Branch protection on `main` requires the four gates.
- **No test may be skipped, disabled or deleted to obtain a green run.** A failing
  test is a finding.

## Revisit when
The gate set materially changes, or CI duration exceeds the point where people
start working around it.
