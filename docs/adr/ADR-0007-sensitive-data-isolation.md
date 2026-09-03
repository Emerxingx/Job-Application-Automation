# ADR-0007 — Candidate sensitive-data isolation

**Status:** Proposed · **Date:** 2026-09-02 · **Implemented (Stage 02, 2026-09-03):** `sensitive` schema and `app_sensitive` role created by SQL with no Prisma model (`prisma/migrations/20260903081500_sensitive_schema`); only `src/lib/sensitive/self-identification.ts` reaches it, own row only, every access audited first and without values. **Scope of the runtime guarantee, precisely:** the `app_tenant` role holds no privilege on the schema, and the résumé projection the scanner, applicator and interview prep consume is loaded as that role (`tests/sensitive-segregation.test.ts`); the rest of the scanner and apply engine still run as the system role (R-35) and are guarded by the allowlist static test, not by a grant. A raw `SET ROLE` inside tenant code could still reach the schema because the connection role is a member of both — which is why raw SQL is confined to `lib/tenancy` and `lib/sensitive`; a dedicated login role for the sensitive path would close that and is recorded for a later stage. Aggregate EEO reporting with small-cohort suppression is not built yet.

## Context
The brief requires voluntary demographic and self-identification data — gender,
ethnicity, veteran status, disability, other protected responses — to be
**architecturally segregated**, and to never influence compatibility, ranking or
career recommendations.

Measured: **no such fields exist yet.** There is therefore no defect today. There
is also no architecture preventing someone from adding `gender` to `User` next
quarter, at which point every existing `SELECT *` on `User` and every AI call
that serialises a profile would silently carry it into scoring and into prompts.

Work authorisation is different: it is **operationally relevant** to eligibility,
so it is not segregated — but it is access-controlled and audited.

## Options
- **A. Same table, application-level exclusion.** One `SELECT *` defeats it.
- **B. Separate columns with column-level grants.** Better; still one join away
  from a scoring query, and easy to include by accident.
- **C. Separate schema with a distinct access path.** Structurally unavailable to
  matching code.

## Decision
**Option C.** Sensitive attributes live in a dedicated `sensitive` schema:

- Written only through an explicit, audited service — never through the general
  profile update path.
- Read only by an explicitly authorised path (EEO reporting, the candidate
  viewing their own data). No matching, scoring, ranking, recommendation or
  document-generation code has grants to the schema.
- The database role used by the matching and AI paths **has no privileges** on
  the sensitive schema, so inclusion is a runtime permission error, not a silent
  leak. *(Stage 02 delivers this for the tenant role, which the résumé
  projection is loaded as; the remaining system-role code on those paths is
  covered by the static test until R-35 completes.)*
- Never serialised into an AI prompt. Enforced by construction (the AI gateway
  receives evidence references, not raw profile rows) **and** by test.
- Collection is voluntary, with an explicit "prefer not to say" that is stored as
  a real value rather than an absence.

## Consequences
- Adding a sensitive field is a deliberate, reviewable act in a separate schema —
  the safe path is the easy path.
- EEO/self-identification reporting is aggregate-only with small-cohort
  suppression.
- A permanent test asserts the matching path cannot read the sensitive schema,
  and a second asserts no prompt payload contains a sensitive field.
- Work authorisation and sponsorship stay in the candidate schema because
  eligibility requires them (`Stage 07`), with access audited.

## Revisit when
A jurisdiction requires sensitive attributes in a decision path (some public-sector
programmes require documented accommodation). That would be an explicit,
legally-reviewed exception with its own ADR — never a quiet relaxation.
