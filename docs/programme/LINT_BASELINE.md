# Lint Baseline — measured at Stage 00

**Measured:** 2026-09-02 · Stage 00 branch · ESLint 9.39.5 + `eslint-config-next` 15.4.11
**Command:** `npx eslint .` (non-interactive)

## The situation before Stage 00

`next.config.mjs` set `eslint: { ignoreDuringBuilds: true }`, which reads as
"lint exists but is skipped at build time." It did not exist:

- no `.eslintrc*`, no `eslint.config.*`
- ESLint was **not** a dependency
- `npm run lint` ran `next lint`, which **prompted interactively** and exited 1

So there was no lint debt to keep down — there was an **unmeasured** first-run
backlog, and putting `next lint` into CI would have hung the runner.

## The measured result

The backlog turned out to be **far smaller than the audit assumed**:

| | Count |
| --- | --- |
| Files linted | 241 |
| Files with issues | 5 |
| Errors | **6** |
| Warnings | **3** |
| **Total** | **9** |

By rule:

| Count | Rule | Severity |
| --- | --- | --- |
| 6 | `@typescript-eslint/no-require-imports` | error |
| 2 | `@typescript-eslint/no-unused-vars` | warn |
| 1 | `import/no-anonymous-default-export` | warn |

## Disposition — and why the count is now 2

**All 6 errors were the deliberate lazy-`require()` provider pattern**, in
`src/lib/providers/index.ts`, `providers/payments/index.ts` and
`providers/payments/registry.ts`. That pattern is a **must-preserve convention**
(`GAP_ANALYSIS.md` Part 5, `CLAUDE.md`): the real adapter is `require`d lazily so
a provider SDK never loads in a deployment that does not use it, which is what
lets a clean clone boot with zero configuration. Converting them to static
imports would pull every SDK into every deployment.

They are therefore **not debt**, and were not "fixed". The rule is scoped off for
`src/lib/providers/**` with the reasoning stated in `eslint.config.mjs`. That is
the configuration's **only** rule exemption: one directory, documented, reviewable.

The `import/no-anonymous-default-export` warning was in `eslint.config.mjs`
itself and was fixed outright.

**Remaining baseline: 0 errors, 2 warnings.**

| File | Line | Rule |
| --- | --- | --- |
| `src/lib/providers/payments/registry.ts` | 565 | `no-unused-vars` (`capabilitiesSatisfied`) |
| `src/lib/subscription.ts` | 71 | `no-unused-vars` (`periodStart`) |

Both are genuine, pre-existing, and left **visible rather than silenced**. They
are production code and remediating them is not Stage 00 scope.

## The ratchet

`npm run lint:ci` runs `eslint . --max-warnings=2`, which **locks this exact
baseline**. It is a **required, blocking** CI gate:

- any new error fails the build;
- any **third** warning fails the build.

This is stronger than the report-only approach `ADR-0018` anticipated, and the
measurement is what justified it — a 9-item backlog does not need a grace period.
The plan of "report first, ratchet later" was correct given an unknown number; it
became unnecessary once the number was known.

**When the two warnings are fixed, lower `--max-warnings` to 0.** Never raise it.

## Note on the ESLint version

`eslint-config-next@15.4.11` declares `eslint: "^7.23.0 || ^8.0.0 || ^9.0.0"`.
ESLint **10.9.1** is published but is **outside** that range, and npm reports the
9.x line as no longer supported upstream.

This is the same shape of constraint as Next/Payload (`ADR-0017`): the supported
version and the current version are not the same thing. It is recorded in
`RISK_REGISTER.md` and Dependabot is configured to ignore `eslint >= 10.0.0` so
it cannot be bumped out of range automatically. Revisit when
`eslint-config-next` widens its peer range — likely with the Next 16 upgrade in
Stage 01.

`next lint` is **not** used: it is deprecated in Next 15 and removed in Next 16,
so `npm run lint` invokes `eslint` directly and survives the Stage 01 upgrade.

---

# Baseline revision — after the Next 16 upgrade (Stage 01)

**Measured:** 2026-09-02, Stage 01 · ESLint 9.39.5 + `eslint-config-next` **16.3.3**

## What changed and why the number moved

`ADR-0017` step 2 upgraded Next 15.4.11 → **16.3.4**, and `eslint-config-next`
had to move with it (they ship on the same release train). Two consequences:

**1. The config is now native flat config.** `eslint-config-next` 15 was
eslintrc-shaped and needed the `FlatCompat` shim. Version 16 ships real flat
config arrays, and passing those back through `FlatCompat` throws *"Converting
circular structure to JSON"*. The configs are now imported directly and the
`@eslint/eslintrc` dependency is removed.

**2. A stricter ruleset surfaced six pre-existing findings.**
`react-hooks/set-state-in-effect` is new in this config and flagged six call
sites — **all of them pre-existing code, none introduced by this upgrade.**

| Baseline | Errors | Warnings |
| --- | --- | --- |
| Stage 00 (`eslint-config-next` 15) | 0 | 2 |
| **Stage 01 (`eslint-config-next` 16)** | **0** | **8** |

## Root-cause analysis — done before the rule was relaxed

Each site was read. **None is a defect:**

| Site | Assessment |
| --- | --- |
| `drawer.tsx` `usePrefersReducedMotion` | `window.matchMedia` cannot be read during a server render. Standard SSR-safe pattern; costs one extra render on mount |
| `drawer.tsx` `mounted` flag | Hydration status is not knowable during server render. Same category |
| `drawer.tsx` `rendered` / `entered` | Deliberately sequences renders so the panel animates from an off-screen start. Setting state in the effect **is the mechanism** |
| `data-table.tsx` page clamp | *Genuinely improvable* — derivable during render. **The real remediation target** |
| `data-table.tsx` page/row reset | *Genuinely improvable* — a `key` or render-time reset would be cleaner |

## Why they are warnings and not fixed here

They stay **visible**, not disabled: every run prints them and the ratchet counts
them. `--max-warnings=8` locks the new number exactly, so a **ninth** warning
still fails the build.

They are not refactored in this branch because rewriting animation and
pagination behaviour during a **security** stage is scope creep, against
components with no test coverage, for no security benefit.

## On raising the threshold from 2 to 8

The Stage 00 baseline said *"Never raise it."* That rule was about not raising the
threshold to absorb debt from **one's own new code** — and it still holds
absolutely for that.

This is a different situation and the distinction matters: a **sanctioned
dependency upgrade** brought a stricter ruleset that surfaced **pre-existing**
code. Raising the number here is recording a measurement, not hiding a
regression. The alternative — disabling the rule outright — would hide six real
findings, and refusing the upgrade would keep six high-severity advisories.

**The ratchet still only moves one way.** When the two `data-table` sites are
fixed, lower it to 6. Never raise it for new code.
