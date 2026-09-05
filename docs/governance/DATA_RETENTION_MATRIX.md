# Data Retention Matrix

Retention is a **policy**, configurable per organisation where a contract requires
it (notably public-sector tenants), with the platform default below.

## The erasure pattern (existing — preserved)
The codebase already implements the correct approach and it is kept: **personal
data is scrubbed in place rather than the row deleted**, because invoices,
payments and audit records must be retained and carry their own bill-to snapshot,
so they still read correctly after erasure. `User.anonymizedAt` marks this.

## Defaults

| Data | Class | Default retention | Trigger | Notes | Enforcement (Stage 23, ADR-0037) |
| --- | --- | --- | --- | --- | --- |
| Candidate profile & digital twin | CONFIDENTIAL | Life of account + 30 days | Account closure | Scrubbed in place | ON EVENT — deleted by account erasure (`executeErasure`, Stage 23) |
| Career evidence | CONFIDENTIAL | Life of account + 30 days | Account closure | | ON EVENT — deleted by account erasure |
| Sensitive demographics | **RESTRICTED** | Life of account, **erased immediately on withdrawal of consent** | Consent withdrawal | No derived copies | ON EVENT — `eraseSelfIdentification` on withdrawal and on erasure |
| Résumés & documents | CONFIDENTIAL | Life of account + 30 days | Account closure | | ON EVENT — deleted by account erasure (rows and objects) |
| **Submitted document versions** | CONFIDENTIAL | **7 years** | — | Candidates must be able to retrieve what was sent on their behalf | STATUTORY-STYLE KEEP for the account's life; leave ONLY through the owner's erasure cascade (trigger); no age-based sweep |
| Applications & Job Folders | CONFIDENTIAL | 7 years | — | Immutable submitted artefacts | KEEP; deleted with the person on erasure; no age-based sweep (NOT AUTOMATED at 7 years) |
| Folder children — status history, contacts, interviews, assessments, follow-ups, notes (Stage 10) | CONFIDENTIAL | With the application (7 years) | Cascade from the application and from the user (erasure) | Contact names and emails are personal data of third parties; audit rows carry ids and kinds only | ON EVENT — cascade |
| Prepared question answers on the application — `Application.preparedQuestions` (Stage 12) | CONFIDENTIAL | With the application (7 years) | Cascade from the application and from the user (erasure) | A copy of the applicant's own stored answers as prepared for one form, with ids and decisions; a `NEVER_AUTOMATE` entry carries no value by construction; sensitive answers are never stored anywhere (ADR-0007) | ON EVENT — cascade |
| Mailbox OAuth tokens — `MailboxSecret` (Stage 11) | RESTRICTED | Until revocation | Revoke (deleted in the same transaction as the purge); erasure | AES-256-GCM under `MAILBOX_ENCRYPTION_KEY`; system-only table with no tenant policy; decrypted only by the sync service | ON EVENT — revocation purge; erasure revokes first |
| Mailbox and calendar references — `EmailThread`, `EmailMessageRef`, `CalendarEventRef`, `IntegrationEvent` (Stage 11) | RESTRICTED | 180 days from the last message unless filed or confirmed, then with the application; purged on revocation | Revoke; erasure; the sweep's prune | Subject, participants, dates, invite flag, event title/organiser/attendees only — **no body is stored or requested**; participants are personal data of third parties | ENFORCED BY SWEEP — `retention:sweep` prunes 180 days for every connected account |
| Job postings & snapshots | INTERNAL | 3 years after `closed_at` | Closure | Snapshots immutable while a referencing application exists | NOT AUTOMATED — no sweep exists for closed postings (Stage 24 backlog) |
| Case notes & assessments | **RESTRICTED** | **Per service-provider contract** (7 years typical) | Contract | Provider policy overrides platform default | PER CONTRACT — `cases:retention` thins closed cases under the organisation's own policy; no policy, no purge |
| Employment outcomes & retention | CONFIDENTIAL | Per contract | Contract | Programme reporting obligations | PER CONTRACT — as above |
| Employer pipelines & submissions | CONFIDENTIAL | 3 years | — | | NOT AUTOMATED — a contract term, not a platform default; the candidate's identity is scrubbed on erasure |
| Staffing contracts & placements | CONFIDENTIAL | 7 years | — | Guarantee periods and disputes | NOT AUTOMATED — contract records; the candidate's identity is scrubbed on erasure, the placement row stays (RESTRICT) |
| Invoices, payments, credit notes | CONFIDENTIAL | **7 years** | — | **Survives account erasure** — statutory | STATUTORY KEEP — never swept, never erased; bill-to snapshot on the row |
| Audit events | INTERNAL | 7 years | — | **Append-only; never edited or deleted** | NEVER — append-only, hash-chained; the sweep and the erasure refuse it statically |
| `ai_runs` | INTERNAL | 2 years | — | Prompt regression analysis and cost reporting | ENFORCED BY SWEEP — two years; deleted with the person on erasure |
| Sessions | CONFIDENTIAL | 30 days, or immediately on revocation | Logout / revoke | | ENFORCED BY SWEEP — thirty days after expiry or revocation; deleted on erasure |
| Rate-limit counters | INTERNAL | Window duration | — | Ephemeral | EPHEMERAL — in-process window |
| Analytics marts | INTERNAL | 3 years | — | Aggregate; small cohorts suppressed | ENFORCED BY SWEEP — three years for the aggregate marts |
| Candidate outcome and match marts — `CandidateOutcomeMart`, `CandidateMatchMart` (Stage 13) | CONFIDENTIAL | With the account (rebuilt from the application rows; deleted with the user) | Erasure cascade | Per-user counts by day and dimension; no free text beyond a job title, company or keyword; user-owned under RLS | ON EVENT — deleted with the person |
| Candidate benchmark mart — `CandidateBenchmarkMart` (Stage 13) | INTERNAL | 3 years | — | Cross-user counts with the distinct-user cohort; suppressed below 5 people on read; system-only | ENFORCED BY SWEEP — three years |
| CMS content | PUBLIC | Indefinite | — | Versioned | NOT AUTOMATED — indefinite by design |

## Rules
1. **Erasure does not defeat statutory retention.** Financial and audit records
   persist with personal identifiers scrubbed.
2. **Consent withdrawal is immediate** for `RESTRICTED` data, including every
   derived artefact (embeddings, classifications, mart rows).
3. **Deletion cascades to derived data.** Deleting a profile deletes its
   embeddings, match rows and mart entries.
4. **Backups are exempt from immediate erasure** but expire on the backup
   schedule; the erasure record ensures the data is re-scrubbed on restore.
5. **Per-organisation override** may only make retention *shorter* for
   `RESTRICTED` data, or *longer* where a contract requires it — never shorter
   than a statutory minimum.
6. Every retention job is audited and reports what it deleted.
7. **Stage 23:** `npm run retention:sweep` (`src/lib/privacy/retention.ts`) enforces every
   row marked ENFORCED BY SWEEP and executes due erasures; account erasure
   (`src/lib/privacy/erasure.ts`, fourteen-day grace, scrub in place) handles every
   row marked ON EVENT; rows marked NOT AUTOMATED are stated, not hidden. There is
   no scheduler: the sweep is an operator command until Stage 24.
