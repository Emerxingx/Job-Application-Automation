# Contributing

This repository is executing a staged build programme. Read
[`docs/programme/MASTER_BUILD_PLAN.md`](docs/programme/MASTER_BUILD_PLAN.md) and
[`docs/programme/STAGE_STATUS.md`](docs/programme/STAGE_STATUS.md) before
starting work — they say what is in scope right now and what is deliberately not.

## Before you start

Read [`CLAUDE.md`](CLAUDE.md). It records the eight things about this codebase
that will otherwise surprise you, including two databases, a SQLite transactional
store with no migrations, and 34 Prisma models with no code behind them.

## Branch and PR governance

- **Never commit to `main`.** It is the approved baseline.
- One branch per stage: `claude/stage-NN-<short-description>`.
- One PR per stage into `main`. Keep it focused — do not pull later-stage scope
  forward because it looks convenient.
- Architecture changes need an ADR in `docs/adr/`, not just a code change.
- `.github/CODEOWNERS` marks the security-critical and governance paths. Changes
  there are reviewed as decisions, not as tidying.

## Verify before you push

```bash
npm run verify
```

which runs, in order:

| Step | Command | Gate |
| --- | --- | --- |
| Lint | `eslint . --max-warnings=2` | **blocking** — locks the measured baseline |
| Typecheck | `tsc --noEmit` | **blocking** |
| Tests | `node --import tsx --test "tests/**/*.test.ts"` | **blocking** |
| Build | `prisma generate && next build` | **blocking** |

CI runs the same four, plus generated-file determinism and the line-ending policy.

## Generated files

`src/app/(payload)/admin/importMap.js` and `src/payload-types.ts` are **generated
and tracked**. Never hand-edit them. Regenerate with:

```bash
npm run cms:importmap
npm run cms:types
```

CI regenerates both and fails if they drift from `src/payload.config.ts`.

`npm run cms:*` temporarily flips `"type": "module"` in `package.json` and
restores it, including on Ctrl-C. If a crash ever leaves it set:
`git checkout package.json`.

## Lint

Baseline is **0 errors, 2 warnings**, locked by `--max-warnings=2`. See
[`docs/programme/LINT_BASELINE.md`](docs/programme/LINT_BASELINE.md). If you fix
one of the two warnings, lower the threshold. **Never raise it.**

The single rule exemption — `no-require-imports` for `src/lib/providers/**` — is
the deliberate lazy-`require` provider pattern. Do not "fix" those.

## Rules that are not negotiable

1. **Never claim a mock is production.** Update
   `docs/governance/INTEGRATION_REGISTER.md` instead.
2. **No autonomous application submission** (`ADR-0016`). Stage 22, gated.
3. **No unlawful data acquisition** — no CAPTCHA bypass, no access-control
   circumvention, no fingerprint evasion.
4. **No sensitive demographic attribute** may reach a matching, scoring, ranking
   or recommendation path (`ADR-0007`).
5. **Never skip, disable or delete a test to get a green run.** A failing test is
   a finding.
6. **Never run `npm audit fix --force`** — it leaves Payload's peer range
   (`ADR-0017`).
7. **Check the tenant filter on every query you write.** There is no RLS yet.
