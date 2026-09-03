# Data Retention Matrix

Retention is a **policy**, configurable per organisation where a contract requires
it (notably public-sector tenants), with the platform default below.

## The erasure pattern (existing — preserved)
The codebase already implements the correct approach and it is kept: **personal
data is scrubbed in place rather than the row deleted**, because invoices,
payments and audit records must be retained and carry their own bill-to snapshot,
so they still read correctly after erasure. `User.anonymizedAt` marks this.

## Defaults

| Data | Class | Default retention | Trigger | Notes |
| --- | --- | --- | --- | --- |
| Candidate profile & digital twin | CONFIDENTIAL | Life of account + 30 days | Account closure | Scrubbed in place |
| Career evidence | CONFIDENTIAL | Life of account + 30 days | Account closure | |
| Sensitive demographics | **RESTRICTED** | Life of account, **erased immediately on withdrawal of consent** | Consent withdrawal | No derived copies |
| Résumés & documents | CONFIDENTIAL | Life of account + 30 days | Account closure | |
| **Submitted document versions** | CONFIDENTIAL | **7 years** | — | Candidates must be able to retrieve what was sent on their behalf |
| Applications & Job Folders | CONFIDENTIAL | 7 years | — | Immutable submitted artefacts |
| Folder children — status history, contacts, interviews, assessments, follow-ups, notes (Stage 10) | CONFIDENTIAL | With the application (7 years) | Cascade from the application and from the user (erasure) | Contact names and emails are personal data of third parties; audit rows carry ids and kinds only |
| Prepared question answers on the application — `Application.preparedQuestions` (Stage 12) | CONFIDENTIAL | With the application (7 years) | Cascade from the application and from the user (erasure) | A copy of the applicant's own stored answers as prepared for one form, with ids and decisions; a `NEVER_AUTOMATE` entry carries no value by construction; sensitive answers are never stored anywhere (ADR-0007) |
| Mailbox OAuth tokens — `MailboxSecret` (Stage 11) | RESTRICTED | Until revocation | Revoke (deleted in the same transaction as the purge); erasure | AES-256-GCM under `MAILBOX_ENCRYPTION_KEY`; system-only table with no tenant policy; decrypted only by the sync service |
| Mailbox and calendar references — `EmailThread`, `EmailMessageRef`, `CalendarEventRef`, `IntegrationEvent` (Stage 11) | RESTRICTED | 180 days from the last message unless filed or confirmed, then with the application; purged on revocation | Revoke; erasure; the sweep's prune | Subject, participants, dates, invite flag, event title/organiser/attendees only — **no body is stored or requested**; participants are personal data of third parties |
| Job postings & snapshots | INTERNAL | 3 years after `closed_at` | Closure | Snapshots immutable while a referencing application exists |
| Case notes & assessments | **RESTRICTED** | **Per service-provider contract** (7 years typical) | Contract | Provider policy overrides platform default |
| Employment outcomes & retention | CONFIDENTIAL | Per contract | Contract | Programme reporting obligations |
| Employer pipelines & submissions | CONFIDENTIAL | 3 years | — | |
| Staffing contracts & placements | CONFIDENTIAL | 7 years | — | Guarantee periods and disputes |
| Invoices, payments, credit notes | CONFIDENTIAL | **7 years** | — | **Survives account erasure** — statutory |
| Audit events | INTERNAL | 7 years | — | **Append-only; never edited or deleted** |
| `ai_runs` | INTERNAL | 2 years | — | Prompt regression analysis and cost reporting |
| Sessions | CONFIDENTIAL | 30 days, or immediately on revocation | Logout / revoke | |
| Rate-limit counters | INTERNAL | Window duration | — | Ephemeral |
| Analytics marts | INTERNAL | 3 years | — | Aggregate; small cohorts suppressed |
| CMS content | PUBLIC | Indefinite | — | Versioned |

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
