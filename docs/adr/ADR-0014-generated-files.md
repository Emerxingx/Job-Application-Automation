# ADR-0014 — Generated-file and line-ending policy

**Status:** Proposed · **Date:** 2026-09-02

## Context
Evidence gathered during this audit:

- **No `.gitattributes` exists.** `core.autocrlf` and `core.eol` are unset in the
  Linux container. Git for Windows commonly defaults `core.autocrlf=true`.
- Two generated artifacts are tracked:
  `src/app/(payload)/admin/importMap.js` and `src/payload-types.ts`.
- `importMap.js` is pure-LF ASCII, 54 lines, carrying Payload's generator marker
  `/** @type import('payload').ImportMap */`.
- Its content is fully derived from `src/payload.config.ts`. The config registers
  one custom component (`afterNavLinks: ['@/cms/components/CrmLauncher']`); one
  such component exists on disk; the map contains exactly one non-package entry.
  **The committed file is in sync with the configuration.**
- **A full `npm run build` did not modify it** — verified: `git diff` empty and
  file mtime unchanged after a successful production build.

A Windows checkout reported `importMap.js` as modified. Given the above, that
modification is generated output or line-ending normalisation, **not a functional
change**. The missing `.gitattributes` is the root cause of the recurring risk.

## Options
- **A. Ignore generated files.** Breaks `next build` where Payload expects
  `importMap.js` present, and makes a clean clone non-deterministic.
- **B. Track them, add `.gitattributes`, verify determinism in CI.**
- **C. Generate at build time only.** Adds a Payload CLI invocation to every
  build; the CLI needs the ESM toggle in `scripts/payload-cli.mjs`, which makes
  builds slower and more fragile.

## Decision
**Option B.**

1. Add `.gitattributes`:
   - `* text=auto eol=lf` — normalise to LF in the repository, on every platform.
   - Explicit `binary` for images, fonts and archives.
   - `*.md text eol=lf`, `package-lock.json text eol=lf -diff` (large, generated).
2. **Track** `importMap.js` and `payload-types.ts`. They are build inputs, and a
   clean clone must build without running codegen.
3. **CI determinism check:** regenerate both, `git diff --exit-code`, fail on
   drift. This converts "someone forgot to regenerate" from a silent
   inconsistency into a build failure.
4. **One-time normalisation** after `.gitattributes` lands:
   `git add --renormalize .` in a single, isolated commit that touches nothing
   else, so it never hides a functional change.
5. Never ignored, never gitignored, never hand-edited. A change to either file is
   only ever the output of `npm run cms:importmap` or `npm run cms:types`.

## Consequences
- Windows contributors stop seeing spurious modifications.
- A stale generated file becomes a red CI run instead of a subtle runtime
  mismatch in the Payload admin.
- The renormalisation commit will touch many files. It is deliberately isolated
  and must be reviewed as a whole-tree line-ending change, not line by line.
- `.env`, `.next/`, `node_modules/`, `storage/`, `media/` and `*.db` remain
  gitignored — the existing `.gitignore` is correct and is not changed.

## Revisit when
Payload changes where or whether it emits the import map.
