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

## Revisit when
Every Next release, or whenever a new advisory affects a deployed path.
