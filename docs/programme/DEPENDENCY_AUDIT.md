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
