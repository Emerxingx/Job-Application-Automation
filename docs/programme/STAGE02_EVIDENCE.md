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
| `20260903081338_candidate_digital_twin` | 11 tables (generated, reviewed: 9 CASCADE to profile, 2 SET NULL, uniques on `userId`, `(profileId, normalizedName)`, `(profileId, language)`), classification comments, **hand-written PL/pgSQL backfill** from `Resume.content` that counts rows actually inserted and **persists its report as a system `AuditLog` row** (`migrate deploy` does not relay NOTICEs) | `tests/digital-twin-backfill.test.ts` executes the migration's own backfill block against a résumé inserted after the history: skips the non-object entry, de-duplicates skills on the normalised form (reports 3 for 4 entries), trims `"Present "`, turns a non-numeric year into `NULL`, skips an unparseable résumé, reports counts, and inserts nothing on a second run |
| `20260903081400_rls_candidate_tables` | policies for the 11 tables, **generated from a manifest** — ordered **before** the sensitive migration so the tables never sit granted-but-unpolicied across a migration boundary | determinism test iterates `RLS_MANIFESTS` |
| `20260903081500_sensitive_schema` | schema `sensitive`, role `app_sensitive`, table `sensitive.self_identification` (RESTRICTED), FORCE RLS, `owner_only` policy, grants to the sensitive role only, explicit revokes from `app_tenant`, `anon`, `authenticated`. **Idempotent** (`IF NOT EXISTS`, `DROP POLICY IF EXISTS`) because Prisma's shadow-database reset clears only `public`, so a fixed shadow database replays this file more than once | applied; replayed twice into one shadow database with no drift; `tests/sensitive-segregation.test.ts` |
| `20260903083000_profile_ownership_keys` | `@@unique([id, userId])` on `CandidateProfile` and composite `(profileId, userId)` foreign keys on all nine child tables, so a row can never carry one user's `profileId` with another's `userId` | generated, reviewed; drift check clean |

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

Migration ordering on a fresh database and on a Stage-01 database is the same
(directory order); each migration is its own transaction, so the RLS policies
for the new tables commit before the sensitive schema's role creation — the
step most likely to differ on a managed host — is attempted.

**Stage 01 defect found and fixed here:** the review-round `REVOKE ALL ON
"_prisma_migrations"` broke `prisma migrate dev` for every developer (Prisma's
shadow database has no ledger table). Guarded by `to_regclass`; ported to the
Stage 01 branch as `250ae94`.

## 3. Sensitive-attribute segregation (ADR-0007) — `PASS`

- **No Prisma model.** The table is created and read by SQL only; the Prisma
  client has no way to select, include or serialise it (asserted).
- **Separate role.** `app_sensitive` holds USAGE on `sensitive` and CRUD on
  the one table, plus EXECUTE on the context accessor — nothing else (asserted:
  it cannot read `CandidateProfile`; the reviewer confirmed SELECT on 0 of 82
  public tables). `app_tenant` cannot name the schema (asserted: "permission
  denied for schema sensitive").
- **Scope of the runtime guarantee — stated exactly.** The guarantee holds for
  every query issued as `app_tenant`. The scanner and applicator load the
  résumé projection as that role (`withTenant` → `loadResumeContent`, asserted),
  but the rest of those two services still run on the system client, which owns
  the sensitive table; for that code the control is the allowlist static test,
  not a grant (R-35 lists the remaining library paths). A raw `SET ROLE
  app_sensitive` from tenant code would also succeed, since the login role is a
  member of both roles; raw SQL is therefore confined to `lib/tenancy` and
  `lib/sensitive` by the same test. A dedicated login role and pool for the
  sensitive path is recorded for a later stage.
- **Own row only.** `owner_only` policy on the transaction-scoped user id; a
  forged write for another user is refused by RLS (asserted).
- **Every access audited FIRST, never the values** (asserted: the audit rows
  contain none of the recorded answers; and with a failing audit store the read
  is refused — the audit is a precondition of the access).
- **"Prefer not to say" is a stored value** on every question.
- **Static proof (allowlist):** `tests/sensitive-segregation.test.ts` scans
  every TypeScript file under `src/` and `scripts/` for the sensitive module,
  schema, table or role, and fails unless the file is one of the six that ARE
  the sensitive path.
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
| Scanner (`runAgentScan`) | read `Resume.content` | `withTenant(…, tx => loadResumeContent(tx, userId))`: structured profile projected **as the tenant role**; an empty profile (preferences saved, no résumé) does not count; legacy JSON only if no usable profile exists |
| Applicator (`applyToJobs`) | same | same |
| Interview prep | same | same, on the tenant path |
| Settings | contact fields | + job preferences form, work authorization form (tenant path), link to self-identification |
| `GET/PUT /api/profile/preferences`, `/api/profile/work-authorization` | — | new, tenant path, zod-validated closed vocabularies |
| Résumé editor and onboarding pages | read `Resume.content` | unchanged: they show the legacy JSON until the first save rewrites it as the projection, so entries the backfill dropped (non-object experience, nameless projects, duplicate skills) remain visible in the editor until then — self-healing on save; the onboarding page still reads on the system client (R-35) |

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

Full suite: **790 / 790, 0 skipped** on PostgreSQL 16 locally; lint 0 / 8;
typecheck 0; build 0 (93 routes).

## 6. Exit gate — verdict

| Gate item | Status |
| --- | --- |
| Structured profile live (a candidate profile fully expressible as relations) | **PASS** — all entities in the plan are tables; editor, scanner, applicator and interview prep read/write them |
| Sensitive isolation proven by test | **PASS for the tenant role** (database, allowlist-static and payload proofs; the résumé projection consumed by scanner/applicator/interview prep loads as that role). The system-role remainder of the scanner and apply engine is guarded by the static test only — recorded, not overclaimed (R-35) |
| Backfill with row counts and a recovery note | **PASS** locally (measured by test); **NOT VERIFIED** on Supabase (R-34) |
| RLS on every new table | **PASS** — 81/81, coverage test |
| Field-level classification | **PASS** — table comments in the migration; `Skill` INTERNAL, the rest CONFIDENTIAL, sensitive RESTRICTED |
| UI on the tenant path with accessibility basics | **PASS** (structure: labels, fieldsets/legends, separate polite status and assertive alert regions with the buttons outside them, `aria-busy`, native controls) / **NOT VERIFIED** (assistive-technology review) |

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

## 8. Independent review — findings and dispositions

| # | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| 1 | HIGH | ADR-0007's runtime claim was true for the tenant role only; scanner/applicator ran as the owner role | **Fixed + re-scoped.** Résumé loading in both now runs as `app_tenant` (`withTenant`), asserted; ADR, evidence and status say exactly what holds for the remaining system-role code |
| 2 | MEDIUM | "Every access audited" was best-effort | **Fixed.** Audit first, `strict`: a read/write/erase whose audit cannot be written does not happen (test with a failing audit store) |
| 3 | MEDIUM | RLS for the new tables applied after the sensitive migration; a mid-deploy failure would leave them granted-but-unpolicied | **Fixed.** Reordered: tables → their RLS → sensitive schema |
| 4 | MEDIUM | Backfill counted attempted skills, and its NOTICE is invisible to `migrate deploy` | **Fixed.** `IF FOUND` counting; report persisted as a system `AuditLog` row; test asserts the counts |
| 5 | MEDIUM | An empty profile (preferences saved first) satisfied the "add your résumé" guard | **Fixed.** `hasResumeContent`; empty profile falls back to legacy JSON or `null`; test |
| 6 | MEDIUM | Static test was a directory denylist | **Fixed.** Allowlist over all of `src/` and `scripts/`; tautological assertion removed |
| 7 | MEDIUM (a11y) | Submit button inside `role="status"`, alert nested in it, no busy state, notice re-read per select | **Fixed.** Separate sibling regions, buttons outside, `aria-busy`, group described once via `fieldset` |
| 8 | LOW | `profileId`/`userId` could disagree | **Fixed.** Composite ownership keys (new migration) |
| 9 | LOW | AI-path read carried preferences and work authorisation | **Fixed.** `RESUME_INCLUDE` |
| 10 | LOW | `SET ROLE app_sensitive` reachable from tenant code (design limit) | **Documented** in the module, ADR and §3; dedicated login role recorded for later |
| 11 | LOW | `"Present "` not trimmed; nested object in `company` | **Fixed.** `btrim`; type guard on `company`/`title` |
| 12 | LOW | Concurrent saves could duplicate rows; achievements nulled on save | **Fixed** (`FOR UPDATE` on the profile row) / **documented** |
| 13 | LOW | Self-identification form: non-OK load spun forever, erase unhandled, no confirmation | **Fixed** |
| 14 | LOW | `Skill` vocabulary must never receive candidate text | **Documented** in the model comment (Stage 04 constraint) |
| 15 | LOW | Editor/onboarding still show legacy JSON until first save | **Recorded** in §4 |
| 16 | NIT | Test-count arithmetic; duplicate of the ported Stage 01 fix | Counts are measured, not derived (see §5); the duplicate commit merges cleanly |
