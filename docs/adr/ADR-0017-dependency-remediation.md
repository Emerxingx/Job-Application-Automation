# ADR-0017 — Dependency security remediation

**Status:** Proposed · **Date:** 2026-09-02

## Context — measured, not assumed

`npm audit` on a clean `npm ci` at `35d3491`: **14 advisories — 1 low, 7
moderate, 6 high, 0 critical.**

### Per-package analysis

| Package | Installed | Sev | Direct | Deployed? | Fix available |
| --- | --- | --- | --- | --- | --- |
| `next` | 15.4.11 | high | yes | **yes** | `15.5.25` — **outside Payload's peer range** |
| `postcss` | 8.4.31 *(nested in `node_modules/next/`)* | high | no | build only | via Next |
| `sharp` | 0.34.5 *(nested in `node_modules/next/`)* | high | no | build only | via Next |
| `deepmerge-ts` → `@prisma/config` → `prisma` | — | high | dev | **no** | yes, direct |
| `esbuild` → `@esbuild-kit/*` → `drizzle-kit` → `@payloadcms/db-*` | ≤0.24.2 | moderate | no | **no** | none |
| `dompurify` → `monaco-editor` | ≤3.4.12 | low/mod | no | admin only | yes |

### Three findings that change the remediation

**1. The project's own `postcss` and `sharp` are already patched.**
Top-level `postcss` is **8.5.26** (advisory needs ≤8.5.22) and top-level `sharp`
is **0.35.3** (advisory needs <0.35.0). The vulnerable copies are Next's own
nested dependencies. Upgrading Next resolves both; nothing else is required.

**2. `next@15.4.11` is the final 15.4.x release.** Verified against the registry:
the 15.4 line ends at 15.4.11. There is no in-band patch. Staying in the 15.4
window means staying permanently unpatched.

**3. A supported upgrade path already exists.** `@payloadcms/next@3.88.0` declares:

```
next: ">=15.2.9 <15.3.0 || >=15.3.9 <15.4.0 || >=15.4.11 <15.5.0 || >=16.2.6 <17.0.0"
```

Payload **already supports `next >=16.2.6 <17.0.0`**. Next 16.3.4 is published and
sits outside the aggregate advisory range (`9.3.4-canary.0 – 16.3.0-preview.10`).

This corrects the prior handoff's framing that the pin exists because Payload
"required `>=15.4.11`". The pin is a sequencing obligation, not a dead end — and
it does not require changing Payload. Also verified: `@payloadcms/next@latest`
**is** 3.88.0, so the installed Payload is current. Payload 4 exists only as
`4.0.0-internal.*` prereleases and is not adoptable.

### The esbuild advisory is not deployed
GHSA-67mh-4wv8-2f99 affects the **esbuild development server**. It reaches this
project only through `drizzle-kit`, Payload's migration CLI, which is never run
in production. Risk is development-machine only.

## Decision

**Do not run `npm audit fix --force`.** It installs `next@15.5.25`, which is
outside Payload's peer range and would break the supported configuration. npm
itself warns of this.

Remediate in this order:

**Step 1 — dev-only, low risk, do first.** Upgrade `prisma` / `@prisma/config` to
resolve the `deepmerge-ts` high advisory. Dev dependency, `fixAvailable: true`.
Gate: full test suite + build.

**Step 2 — the real fix. Next 15.4.11 → 16.2.6+ (target 16.3.4).**
Inside Payload's declared peer range; no Payload change needed. This is a **major
Next upgrade** and must be treated as one:
- Read the Next 15→16 upgrade guide and breaking-change list from official docs.
- Verify React 19.2.8 satisfies both Next 16 and
  `@payloadcms/richtext-lexical`'s `^19.0.1 || ^19.1.2 || ^19.2.1`.
- Full regression before merge: 670 tests, typecheck, build, **and** manual
  verification of the Payload admin at `/admin`, the CMS REST/GraphQL routes, the
  Stripe webhook, and the CMS fallback path.
- Confirm nested `postcss`/`sharp` are resolved by re-running `npm audit`.
- Merge behind CI (`ADR-0018`), on its own branch, with no other change in the
  diff.

**Step 3 — accept with documented compensating controls.** The
`esbuild`/`drizzle-kit` chain has no fix and is not deployed. Record in
`RISK_REGISTER.md`: development-only exposure, no production code path, revisit
when Payload updates its adapter dependencies.

**Step 4 — `dompurify`/`monaco-editor`.** Payload admin surface, low/moderate.
Resolves with a future Payload release; track, do not force.

## Consequences
- Steps 1 and 2 are Stage 01 blockers. No production deployment happens with the
  current Next version.
- `npm audit --audit-level=high` becomes a **blocking** CI gate once Step 2
  lands; until then it runs in reporting mode so it does not block Stage 00 work.
- Payload's peer range is checked **before every future Next upgrade**. This is a
  standing obligation of `ADR-0003`.
- If Step 2 regression fails, the fallback is *not* to force the upgrade. It is
  to stay on 15.4.11 with compensating controls (WAF rules, disabled image
  optimizer, no custom-server Server Actions), record the accepted risk, and
  block production until resolved.

## Outcome — Step 2 performed in Stage 01 (2026-09-02)

`next` 15.4.11 → **16.3.4**, with `eslint-config-next` 15.4.11 → 16.3.3 moved in
lockstep (they ship on the same release train). Inside Payload 3.88.0's declared
peer range; **Payload was not changed**.

| | Advisories | high |
| --- | --- | --- |
| Before | 14 | 6 |
| **After** | **11** | **3** |

**Every deployed high-severity advisory known at that moment was cleared.** The
three remaining highs were the dev-only `prisma` / `@prisma/config` /
`deepmerge-ts` chain — Step 1, still outstanding, and deliberately not bundled
with a framework upgrade.

> **Superseded later in the same stage, without anything being installed.** A
> newly published `fast-uri` advisory made `payload → ajv` a deployed high again.
> See the Step 1 outcome below. The sentence above was accurate when written and
> is left standing, dated, as the record of why a dependency posture is a
> measurement with a timestamp rather than a property.

Regression: lint 0 errors, typecheck exit 0, **689/689 tests**, build exit 0 on
Turbopack.

Two required follow-ons, both done in the same change:
- **`middleware.ts` → `src/proxy.ts`.** Next 16 deprecates the middleware
  convention. Verified against Next's loader source, not guessed.
- **ESLint moved to native flat config.** `eslint-config-next` 16 ships real flat
  config; `FlatCompat` throws on it. `@eslint/eslintrc` removed.

The stricter ruleset surfaced six pre-existing `react-hooks/set-state-in-effect`
sites. Each was analysed (`LINT_BASELINE.md`); none is a defect, and they are
recorded as visible warnings rather than disabled.


## Outcome — Step 1 performed in Stage 01 (2026-09-02), not as specified

**Step 1 as written was not achievable.** It assumed a Prisma release consuming a
patched `deepmerge-ts`. Verified against the registry: `@prisma/config` pins
`deepmerge-ts` **exactly at the vulnerable `7.1.5`** in 6.19.3 *and* in 7.10.0,
the latest release. `npm audit`'s `fixAvailable: true` reports that a patched
`deepmerge-ts` exists, not that anything upstream uses it. Upgrading Prisma would
have cost the `package.json#prisma` block (removed in Prisma 7) and fixed
nothing.

It was performed as a scoped `overrides` entry instead, together with two
advisories that had appeared in the interval:

| Override | → | Parent's declared range | Character of the change |
| --- | --- | --- | --- |
| `fast-uri` | 3.1.7 | `ajv@8.18.0`: `^3.0.1` | inside the range — **deployed high**, four advisories via `payload → ajv` |
| `qs` | 6.16.0 | `stripe@17.7.0`: `^6.11.0` | inside the range — deployed moderate |
| `deepmerge-ts` | 8.0.2 | `@prisma/config`: exactly `7.1.5` | **outside an exact pin**, justified below |

Only the third overrides a pin, and it was verified rather than assumed:
`@prisma/config` imports one symbol (`deepmerge`), version 8 still exports it,
and version 8's change *is* the fix — the default `deepmerge` became the
recursion-safe implementation and the old fast path was renamed
`deepmergeFastUnsafe`. `prisma validate`, `generate`, `-v` and `db push` were
then all run against it successfully.

| | Total | high |
| --- | --- | --- |
| Before | 13 | 4 |
| **After** | **8** | **0** |

Regression: lint 0 errors / 8 warnings, typecheck exit 0, **699/699 tests**,
build exit 0.

**Standing obligation:** remove the `deepmerge-ts` override when `@prisma/config`
depends on `^8`. An override on someone else's exact pin must not outlive its
reason. Full working in `../programme/DEPENDENCY_AUDIT.md`.

## Outcome — Step 4 deliberately not taken (2026-09-02)

`dompurify` / `monaco-editor` remain, for a sharper reason than "track, do not
force". `monaco-editor@0.56.0` — the latest release — pins `dompurify` at exactly
`3.4.8`, so clearing it needs the same outside-the-pin override used above. The
difference that decides it: the Payload admin's code-editor field is exercised by
neither the test suite nor the build, so the override could be applied but **not
verified** here. An unverified change to a security-sensitive sanitiser is a
worse position than a tracked moderate on a staff-only surface. Revisit when
Payload updates `@payloadcms/ui`, or when there is a way to exercise that field.

**`npm audit --audit-level=high` is now clean**, which is what makes it adoptable
as a blocking CI gate — the consequence recorded above. It is not yet wired in;
that is a deliberate separate change, because a gate that turns red on someone
else's publication schedule needs its failure mode designed first.

## Revisit when
Every Next release, or whenever a new advisory affects a deployed path. **17.x is
outside Payload's peer range** — do not take it without checking Payload first.
