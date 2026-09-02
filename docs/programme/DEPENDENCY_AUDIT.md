# Dependency Security — recorded state at Stage 00

**Measured:** 2026-09-02, Stage 00 branch, after `npm ci` plus the Stage 00
ESLint install · Node v22.22.2 · npm 10.9.7
**Command:** `npm audit` / `npm audit --json`

Stage 00 establishes **visibility**. It does not remediate: the Next.js upgrade
is Stage 01 under `../adr/ADR-0017-dependency-remediation.md`.

## Current state — unchanged from the architecture baseline

```
1 low · 7 moderate · 6 high · 0 critical  →  14 total
```

Adding ESLint, `eslint-config-next` and `@eslint/eslintrc` (219 packages)
introduced **no new advisories**. The count is identical to the figure measured
at `35d3491` during the architecture audit.

## Per package

| Package | Severity | Direct | Deployed? | Fix available | Owner |
| --- | --- | --- | --- | --- | --- |
| `next` 15.4.11 | **high** | yes | **yes** | `15.5.25` — **outside Payload's peer range** | **Stage 01** (`ADR-0017`) |
| `postcss` (nested in `node_modules/next/`) | **high** | no | build only | via Next | Stage 01 |
| `sharp` (nested in `node_modules/next/`) | **high** | no | build only | via Next | Stage 01 |
| `prisma` | **high** | yes | dev | yes, direct | Stage 01 |
| `@prisma/config` | **high** | no | dev | yes | Stage 01 |
| `deepmerge-ts` | **high** | no | dev | yes | Stage 01 |
| `@payloadcms/db-postgres` | moderate | yes | no | none | accepted (`R-23`) |
| `@payloadcms/db-sqlite` | moderate | yes | no | none | accepted (`R-23`) |
| `drizzle-kit` | moderate | no | no | none | accepted (`R-23`) |
| `esbuild` | moderate | no | **no** | none | accepted (`R-23`) |
| `@esbuild-kit/core-utils` · `@esbuild-kit/esm-loader` | moderate | no | no | none | accepted (`R-23`) |
| `dompurify` | moderate | no | admin only | yes | tracked |
| `monaco-editor` | low | no | admin only | yes | tracked |

## Two facts that shape remediation

**The project's own `postcss` and `sharp` are already patched.** Top-level
`postcss` is 8.5.26 and top-level `sharp` is 0.35.3 — both outside their advisory
ranges. The vulnerable copies are Next's own nested dependencies, so upgrading
Next resolves them and nothing else is required.

**`npm audit fix --force` must never be run.** It installs `next@15.5.25`, which
is **outside** `@payloadcms/next@3.88.0`'s declared peer range
(`>=15.2.9 <15.3.0 || >=15.3.9 <15.4.0 || >=15.4.11 <15.5.0 || >=16.2.6 <17.0.0`)
and would break the supported configuration. npm itself warns of this. The
supported target is **Next 16.2.6+**, inside that range — Stage 01.

## Why CI reporting is not blocking yet

`.github/workflows/dependency-review.yml` runs `npm audit` on every PR, on pushes
to `main`, and weekly, and uploads the JSON — but with `continue-on-error`.

A blocking `--audit-level=high` gate would fail on day one for a **known,
scheduled, documented** reason, and a gate that always fails is a gate that gets
switched off. It becomes blocking once `ADR-0017` Step 2 lands in Stage 01.

That is a deliberate, recorded choice — not a suppression. The advisories are
reported in full on every run.

## The ESLint version constraint (new, found in Stage 00)

`eslint-config-next@15.4.11` declares `eslint: "^7.23.0 || ^8.0.0 || ^9.0.0"`.
ESLint **10.9.1** is published, and npm reports the 9.x line as no longer
supported upstream — so the supported-by-Next version and the
supported-by-upstream version have diverged.

This is the same constraint shape as Next/Payload. Recorded as **R-30** in
`../governance/RISK_REGISTER.md`; Dependabot is configured to ignore
`eslint >= 10.0.0` so automation cannot push it out of range. Revisit with the
Next 16 upgrade, which will also bring a newer `eslint-config-next`.

## Defect found after Stage 00 merged — automated majors

Within minutes of Dependabot being enabled it opened **eight** PRs, several of
which would have broken the build:

| PR | Bump | Why it is unsafe |
| --- | --- | --- |
| #12 | `prisma` 6.19.3 → **7.10.0** | Prisma 7 removes the `package.json#prisma` config block this repo still uses — the build already warns about it. Coordinated with the PostgreSQL migration (`ADR-0002`), not a bump |
| #10 | `stripe` 17.7.0 → **22.6.0** | `src/lib/providers/payments/stripe.ts` pins `apiVersion: '2025-02-24.acacia'`; a major SDK jump changes the accepted API versions and the types |
| #11 | `eslint-config-next` 15.4.11 → **16.3.3** | Ships on the Next release train; moving it ahead of `next` (pinned by Payload) desyncs the toolchain |
| #5–#7 | `actions/*` 4 → **7** | Action majors change runner and Node requirements, on the workflow that proves everything else |

**Root cause:** the first config grouped patch and minor updates but placed **no
constraint on majors**, so every major arrived as its own ungrouped PR. That is
the precise opposite of the stated intent — sparing a non-technical founder a
stream of risky PRs.

**Fix:** `version-update:semver-major` is ignored for **every** npm dependency and
every GitHub Action, with named entries for the four cases above so the reason
survives. Majors are now a deliberate human decision with their own regression
run; for `next`/`payload` that decision is `ADR-0017`.

Dependabot closes PRs that no longer match its configuration, so the eight
should retire once this lands. **None of them was merged.**

**The lesson worth keeping:** automation added in Stage 00 was itself a change
that needed reviewing against reality, not just configuring. It was only visible
because the PRs appeared and were read.

## Stage 01 — advisories closed, and one ADR step that could not be performed as written

Re-measured 2026-09-02, after the Next 16 upgrade.

| | Total | high | moderate | low |
| --- | --- | --- | --- | --- |
| Architecture baseline (`35d3491`) | 14 | 6 | 7 | 1 |
| After the Next 16 upgrade | 11 | 3 | 7 | 1 |
| Before this change | 13 | **4** | 8 | 1 |
| **Now** | **8** | **0** | 7 | 1 |

### Why the count rose from 11 to 13 without the tree changing

Two advisories were **published** in the interval; nothing was installed or
upgraded. `payload@3.88.0` and `stripe@17.7.0` are the same versions throughout,
and the arithmetic matches exactly: `fast-uri` added one high, `qs` added one
moderate, low unchanged. This is worth stating plainly because "advisories went
up after we fixed advisories" otherwise reads as a regression.

It also corrects the Next 16 outcome note in `../adr/ADR-0017-dependency-remediation.md`:
"every deployed high-severity advisory is cleared" was true when written and
stopped being true four days later, through no change of ours. A dependency
posture is a measurement with a date on it, not a property.

### What was fixed, and why each fix is safe

All three are `overrides` in `package.json`. No direct dependency's declared
version changed, and neither `payload`, `stripe` nor `prisma` was touched.

| Override | Was | Now | Parent's declared range | Verdict |
| --- | --- | --- | --- | --- |
| `fast-uri` | 3.1.5 | **3.1.7** | `ajv@8.18.0` declares `^3.0.1` | **Inside the range.** Not a forced upgrade — npm simply had no reason to move it |
| `qs` | 6.15.3 | **6.16.0** | `stripe@17.7.0` declares `^6.11.0` | **Inside the range.** Same |
| `deepmerge-ts` | 7.1.5 | **8.0.2** | `@prisma/config@6.19.3` pins **exactly `7.1.5`** | **Outside the pin** — justified and verified below |

`fast-uri` was the one that mattered: four high-severity advisories (two SSRF,
two host-confusion) reached through `payload → ajv`, which is **deployed**.

### `ADR-0017` Step 1 could not be performed as written

Step 1 said: *"Upgrade `prisma` / `@prisma/config` to resolve the `deepmerge-ts`
high advisory. Dev dependency, `fixAvailable: true`."*

Verified against the registry: **no released Prisma consumes a patched
`deepmerge-ts`.** `@prisma/config` pins it exactly, and pins the *same*
vulnerable version at 6.19.3 and at 7.10.0, the latest release. `npm audit`
reporting `fixAvailable: true` means a patched `deepmerge-ts` exists — not that a
Prisma release uses it. Upgrading Prisma would have cost the
`package.json#prisma` block (removed in Prisma 7) and bought nothing.

So the step was performed by override instead, and the risk of breaking an exact
pin was retired by evidence rather than by hope:

1. **API compatibility checked before applying.** `@prisma/config` imports
   exactly one symbol, `deepmerge`. Version 8 still exports it; what 8 changed is
   that the default `deepmerge` is now the recursion-safe implementation, with
   the old fast path renamed `deepmergeFastUnsafe`. The advisory *is* that
   change, and the symbol in use is the one that got fixed.
2. **The CLI was then exercised, not assumed:** `prisma validate`,
   `prisma generate`, `prisma -v` and `prisma db push` against a throwaway SQLite
   file all succeed. Every one of them loads config through the overridden
   package.
3. **Full gate set green** — lint, typecheck, 699 tests, build.

**Remove this override** when `@prisma/config` ships a dependency on
`deepmerge-ts@^8`. It is a patch applied on the outside of someone else's pin and
should not outlive the reason for it.

### What is deliberately left

Eight advisories remain: **zero high, seven moderate, one low.**

- **Six are the `esbuild` → `@esbuild-kit/*` → `drizzle-kit` → `@payloadcms/db-*`
  chain.** No fix exists, and the advisory affects the esbuild *dev server*.
  `drizzle-kit` is Payload's migration CLI and never runs in production.
  Unchanged: **R-23**, accepted with compensating controls.
- **Two are `dompurify` / `monaco-editor`**, reaching the Payload admin's code
  editor through `@payloadcms/ui`. `monaco-editor@0.56.0` — the latest release —
  pins `dompurify` at exactly `3.4.8`, so clearing them needs the same
  outside-the-pin move used for `deepmerge-ts`. It is **not** taken, for a reason
  that does not apply there: the admin code-editor field is not exercised by the
  test suite or the build, so the override could not be *verified* in this
  environment, only hoped for. An unverifiable change to a security-sensitive
  sanitiser is worse than a tracked moderate. `ADR-0017` Step 4 stands: track,
  do not force.
