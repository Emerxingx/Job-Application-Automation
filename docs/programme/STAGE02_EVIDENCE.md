# Stage 02 — Candidate Digital Twin — evidence

Recorded 2026-09-03 on branch `claude/stage-02-candidate-digital-twin`,
stacked on the Stage 01 branch (PR #13, PARTIAL). Same vocabulary and same
rule as Stage 01: every line was run or read; nothing is PASS on the strength
of a mock, a skipped test or a document.

## 1. The structured profile (G-10)

Eleven new tables, all classified `CONFIDENTIAL` except the shared `Skill`
vocabulary (`INTERNAL`), each carrying its classification as a table comment
in the migration (`DATA_CLASSIFICATION.md` rule 1):

| Entity | Table | Notes |
| --- | --- | --- |
| Profile | `CandidateProfile` | one per user; `headline`, `summary`, `source`, `backfilledAt` |
| Employment history | `EmploymentHistory` | month-precision dates, `isCurrent`, bullets as the unit the résumé engine tailors |
| Education | `Education` | level, field, years |
| Skills | `Skill` (shared vocabulary) + `CandidateSkill` | normalised name, optional link to the vocabulary; Stage 04 attaches taxonomy codes |
| Certifications | `Certification` | issuer, dates, credential id/url |
| Projects | `Project` | technologies as a list |
| Achievements | `Achievement` | quantified outcome, optionally tied to a role — the future evidence unit (Stage 03) |
| Languages | `CandidateLanguage` | proficiency |
| Career preferences | `CareerPreferences` | target/adjacent titles, employment types, work modes, locations, countries, salary floor, travel, relocation, **`recruiterVisibility` default `hidden`**, **`autonomy` default and only permitted value `assist_only`** (ADR-0016), notice period, availability |
| Work authorization | `WorkAuthorization` | country, status, permit, sponsorship — CONFIDENTIAL, not sensitive-segregated (eligibility needs it), access-controlled |

Every child row carries `userId`, so every table is the plain `user` RLS kind
(no join in the policy) and a row cannot be re-parented across users.

## 2. Migrations — `PASS` locally; `NOT VERIFIED` on Supabase (R-34, unchanged)

| Migration | Content | Rehearsal |
| --- | --- | --- |
| `20260903081338_candidate_digital_twin` | 11 tables (generated, reviewed: 9 CASCADE to profile, 2 SET NULL, uniques on `userId`, `(profileId, normalizedName)`, `(profileId, language)`), classification comments, **hand-written PL/pgSQL backfill** from `Resume.content` | `tests/digital-twin-backfill.test.ts` executes the migration's own backfill block against a résumé inserted after the history: skips the non-object entry, de-duplicates skills on the normalised form, turns a non-numeric year into `NULL`, skips an unparseable résumé with a NOTICE, and inserts nothing on a second run |
| `20260903081500_sensitive_schema` | schema `sensitive`, role `app_sensitive`, table `sensitive.self_identification` (RESTRICTED), FORCE RLS, `owner_only` policy, grants to the sensitive role only, explicit revokes from `app_tenant`, `anon`, `authenticated` | applied; `tests/sensitive-segregation.test.ts` |
| `20260903081600_rls_candidate_tables` | policies for the 11 tables, **generated from a manifest** | determinism test now iterates `RLS_MANIFESTS` |

Expand phase only: `Resume.content` is **not dropped**; it is rewritten as a
projection of the structured rows on every save (`writeResumeProjection`), and
the contract migration is a later stage once no reader remains. The RLS
generator became manifest-driven (`src/lib/tenancy/rls-tables.ts` →
`RLS_MANIFESTS`): a table's policies live in the migration that introduced it,
and a later reclassification re-emits them in a new migration (idempotent
DDL) instead of editing an applied file.

After the history: 81/81 public tables `ENABLE`+`FORCE`, 150 public policies,
`sensitive` schema present, `app_tenant` has **no** USAGE on it, drift check
"No difference detected".

**Stage 01 defect found and fixed here:** the review-round `REVOKE ALL ON
"_prisma_migrations"` broke `prisma migrate dev` for every developer (Prisma's
shadow database has no ledger table). Guarded by `to_regclass`; ported to the
Stage 01 branch as `250ae94`.

## 3. Sensitive-attribute segregation (ADR-0007) — `PASS`

- **No Prisma model.** The table is created and read by SQL only; the Prisma
  client has no way to select, include or serialise it (asserted).
- **Separate role.** `app_sensitive` holds USAGE on `sensitive` and CRUD on
  the one table, plus EXECUTE on the context accessor — nothing else (asserted:
  it cannot read `CandidateProfile`). `app_tenant` cannot name the schema
  (asserted: "permission denied for schema sensitive").
- **Own row only.** `owner_only` policy on the transaction-scoped user id; a
  forged write for another user is refused by RLS (asserted).
- **Every access audited, never the values** (asserted: the audit rows contain
  none of the recorded answers).
- **"Prefer not to say" is a stored value** on every question.
- **Static proof:** `tests/sensitive-segregation.test.ts` greps
  `src/lib/services`, `providers/ai`, `providers/apply`, `providers/jobs`,
  `resume-render`, `prompt-*`, `candidate`, `analytics`, `exports` for any
  reference to the sensitive module, schema, table or role, and fails on one.
- **Payload proof:** the résumé projection of a candidate who recorded answers
  contains none of them; the projection's field set is enumerated
  (`tests/candidate-profile.test.ts`).
- Surface: `GET/PUT/DELETE /api/profile/self-identification` (own answers;
  requires a session; does **not** use the tenant path, by design) and a
  separate settings page, loaded on demand because reads are audited.

## 4. Application paths

| Path | Before | Now |
| --- | --- | --- |
| `PUT /api/resume` | wrote `Resume.content` JSON | writes the structured rows, then the projection, in one tenant transaction |
| Scanner (`runAgentScan`) | read `Resume.content` | `loadResumeContent(db, userId)`: structured profile projected; legacy JSON only if no profile exists |
| Applicator (`applyToJobs`) | same | same |
| Interview prep | same | same, on the tenant path |
| Settings | contact fields | + job preferences form, work authorization form (tenant path), link to self-identification |
| `GET/PUT /api/profile/preferences`, `/api/profile/work-authorization` | — | new, tenant path, zod-validated closed vocabularies |

Accessibility of the new forms: every control labelled, groups as
`fieldset`/`legend`, help text via `aria-describedby`, save status in an
`aria-live` region, error text with `role="alert"`, icons `aria-hidden`.
Keyboard-only operation and screen-reader review were **not** performed
with a real assistive technology in this environment — `NOT VERIFIED`; Stage
23 audits it.

## 5. Tests

| File | What | Count |
| --- | --- | --- |
| `tests/candidate-profile.test.ts` | projection, sensitive-field-free shape, skill normalisation, preference validation (autonomy above `assist_only` refused) | 7 |
| `tests/digital-twin-backfill.test.ts` | migration backfill executed, counts, idempotency, round trip, editor save path | 4 |
| `tests/sensitive-segregation.test.ts` | static + database + payload segregation | 9 |
| `tests/rls-migration-determinism.test.ts` | now per manifest + manifest coverage | 3 |
| `tests/tenancy-isolation.test.ts` | unchanged assertions over 81 tables | 13 |

Full suite: **788 / 788, 0 skipped** on PostgreSQL 16 locally; lint 0 / 8;
typecheck 0; build 0 (93 routes).

## 6. Exit gate — verdict

| Gate item | Status |
| --- | --- |
| Structured profile live (a candidate profile fully expressible as relations) | **PASS** — all entities in the plan are tables; editor, scanner, applicator and interview prep read/write them |
| Sensitive isolation proven by test | **PASS** — database, static and payload proofs |
| Backfill with row counts and a recovery note | **PASS** locally (measured by test); **NOT VERIFIED** on Supabase (R-34) |
| RLS on every new table | **PASS** — 81/81, coverage test |
| Field-level classification | **PASS** — table comments in the migration; `Skill` INTERNAL, the rest CONFIDENTIAL, sensitive RESTRICTED |
| UI on the tenant path with accessibility basics | **PASS** (structure) / **NOT VERIFIED** (assistive-technology review) |

**Stage 02: PASS on every engineering gate reachable from this environment;
carries Stage 01's staging blocker (R-34) for the migration rehearsal.** Merge
is stacked on Stage 01 and therefore inherits its merge posture.

## 7. Deferred, recorded

- Achievements and languages have tables and RLS but no editor UI yet (Stage 03
  gives achievements their evidence role; the UI arrives with it).
- `User.workAuth` (free text) stays until Stage 07 reads only
  `WorkAuthorization`; both are shown in Settings meanwhile.
- Skill ↔ taxonomy linking (`Skill.taxonomyCode`) is Stage 04.
- Erasure: `eraseSelfIdentification` exists; wiring it into the account
  deletion flow lands with the deletion job (the `DeletionRequest` processor
  is still unwired — Stage 10/23).
