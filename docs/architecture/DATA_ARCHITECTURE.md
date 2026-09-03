# Data Architecture

## Decisions
- **One PostgreSQL instance** as the transactional system of record (`ADR-0002`).
- **Logical schemas, not physical databases.** Do not split prematurely.
- **Versioned Prisma migrations.** `db push` is development-only. Versioned and
  reproducible is **not** the same as reversible — Prisma emits no down
  migrations, so recovery comes from backups, restore points and written recovery
  plans, per the production migration standard in `ADR-0002`.
- **pgvector** on the same instance for embeddings — no separate vector store.
- **Payload keeps its own logical database** on the same instance (`ADR-0003`).

## Current state (measured, 2026-09-03)
- Provider: **PostgreSQL** (Stage 01). 81 models in `public` plus the SQL-only
  `sensitive.self_identification` (Stage 02).
- **Six migrations** under `prisma/migrations/`, CI-validated; RLS generated per
  manifest (`src/lib/tenancy/rls-tables.ts`), every table forced.
- `User` still carries the contact fields; the career profile is the eleven
  `Candidate*`/`EmploymentHistory`/`Education`/… tables (Stage 02). `Resume.content`
  is a derived projection kept during the expand phase.
- JSON list columns are still text (`bullets`, `targetTitles`, …) — deliberate
  baseline decision, see `../operations/DATABASE_MIGRATIONS.md`.

## Target schemas

```
identity.*          users, sessions, credentials, mfa, oauth_identities
organization.*      organizations, memberships, roles, permissions
candidate.*         profiles, employment_history, education, skills,
                    certifications, projects, achievements, languages,
                    career_preferences, work_authorization, consents
sensitive.*         demographic self-identification — SEPARATE GRANTS (ADR-0007)
career_evidence.*   evidence, evidence_sources, application_answers,
                    question_policies
job.*               job_sources, job_postings, job_snapshots, job_requirements,
                    job_skills, companies
matching.*          eligibility_results, candidate_job_matches, match_dimensions,
                    match_weight_versions
application.*       applications, application_events, application_answers,
                    application_documents, interviews, assessments, offers,
                    outcomes
document.*          documents, document_versions, resume_versions, cover_letters
communication.*     email_connections, email_threads, email_messages,
                    calendar_connections, calendar_events
talent.*            employer_accounts, recruiters, requisitions, talent_pools,
                    candidate_submissions, pipelines, offers, hires
staffing.*          client_contracts, engagements, fee_structures, placements,
                    guarantee_periods, representation_consents
case_management.*   service_providers, centres, case_managers,
                    client_assignments, cases, assessments, employment_plans,
                    case_notes, interventions, training_referrals,
                    employment_outcomes, retention_events
career.*            occupations, skills_taxonomy, occupation_skills,
                    career_paths, skill_gaps
learning.*          learning_programs, certifications_catalog, providers,
                    learning_plans
billing.*           customers, products, prices, subscriptions, entitlements,
                    usage, invoices, payments, credit_notes, refunds
integration.*       integrations, integration_connections, integration_logs,
                    api_keys, webhook_endpoints, webhook_deliveries,
                    outbound_events
governance.*        consents, audit_events, privacy_requests,
                    retention_policies, data_classifications, feature_flags,
                    ai_prompts, ai_prompt_versions, ai_runs
analytics.*         marts and materialized views only — never written by product code
```

## Migration strategy from the current schema

1. **Baseline, do not rewrite.** The existing 68 models become migration `0001`
   against PostgreSQL. 670 passing tests are the regression guard.
2. **Port types.** Text-JSON columns become real `Json`. Dates and booleans are
   verified against SQLite's looser typing.
3. **Rehome by schema.** Existing models move into logical schemas without
   structural change where possible.
4. **Decompose `User`** into `identity.users` + `candidate.profiles` +
   `sensitive.*` (Stage 02) using expand-and-backfill: add, backfill, verify, and
   drop the old columns only in a later migration, so a recovery window stays open.
5. **Resolve the 34 unreferenced models**, each explicitly:
   - **Wire** — `Organization`, `Membership`, `AgentSchedule`, `WebhookEvent`,
     `ImpersonationSession`, `DeletionRequest`, `EmailToken`, `Notification`,
     `FeatureFlag`, `PlanPrice`, `BillingProfile`.
   - **Keep** — nested-write models that are genuinely in use (`InvoiceLine`,
     `InvoiceTaxLine`, `PaymentAllocation`, `DocumentSequence`, `TaxRate`).
   - **Defer with a dated note** — commercial models beyond current scope
     (`Coupon`, `Referral`, `CreditLedgerEntry`, …). Retained deliberately, not
     by neglect.
   No model is dropped without an explicit decision recorded here.

## Conventions
- Surrogate `cuid()`/`uuid` primary keys; natural keys as unique constraints.
- Every tenant-scoped table carries `organization_id` (nullable only for
  candidate-owned rows) and an RLS policy keyed on **transaction-scoped** session
  context, written so unset or invalid context matches **no rows** (`ADR-0005`).
- The **connection-pooling mode is part of the data architecture**, not an ops
  detail: it determines whether tenancy context can leak between requests. The
  selected mode and its implications are recorded in
  `DEPLOYMENT_ARCHITECTURE.md` and proven by the Stage 01 pooled-runtime
  isolation gate.
- Timestamps `created_at` / `updated_at` on every table; `deleted_at` only where
  soft delete is genuinely required.
- Money as integer minor units plus an explicit currency. **Never floats.**
- Enums as constrained strings with a documented value set (matches the existing
  convention and keeps migrations cheap).
- Append-only tables (`audit_events`, `application_events`, `job_snapshots`) have
  no `UPDATE` grant.

## Retention and deletion
Driven by `../governance/DATA_RETENTION_MATRIX.md`. The existing PIPEDA-aware
pattern is **preserved**: personal data is scrubbed in place rather than the row
deleted, because invoices, payments and audit records must be retained and carry
their own bill-to snapshot. `anonymizedAt` already implements this on `User`.
