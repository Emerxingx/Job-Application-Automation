# Data Classification

Four levels. Classification drives access control, logging, retention, residency
and whether data may be sent to an AI provider.

## RESTRICTED
The highest level. Exposure causes serious harm to an individual.

- **Sensitive demographic self-identification** — gender, ethnicity, veteran
  status, disability. *(No such field exists yet; the class is defined before it
  does.)*
- **WorkBC case notes**, assessments, barriers.
- **Mailbox and calendar content.**
- Government identifiers.
- Health-related accommodation information.

**Controls:** physically separate schema where applicable (`ADR-0007`); separate
database grants; access on an explicit authorised path only; **every access
audited**; never in logs; never in analytics without aggregation and small-cohort
suppression; **never sent to an AI provider** (mailbox content only with explicit
consent); Canadian residency mandatory; shortest viable retention.

**Hard rule:** no `RESTRICTED` data may enter a matching, scoring, ranking or
recommendation path. Enforced by database grants, so inclusion is a runtime
permission error rather than a silent leak.

## CONFIDENTIAL
Personal or commercially sensitive; exposure causes real harm.

- Candidate profile, employment history, education, résumés, cover letters.
- Career evidence; application answers.
- Work authorization and sponsorship status.
- Applications, Job Folders, interviews, offers, outcomes.
- Employer pipelines, submissions, talent pools.
- Staffing contracts, fee structures, placement fees.
- Billing profiles, invoices, payment records.
- API keys, webhook secrets, OAuth tokens.

**Controls:** RLS on every table; consent or assignment gating for third-party
access; encrypted at rest and in transit; **redacted from logs**; Canadian
residency; AI access limited to the minimum necessary, by evidence reference
rather than whole records.

## INTERNAL
Operational data; exposure is embarrassing but not directly harmful.

Job postings and snapshots; occupation and skills taxonomy; matching weights and
versions; prompt registry; connector configuration and health; aggregate
analytics; audit metadata; feature flags.

**Controls:** authenticated access; role-based; standard retention.

## PUBLIC
Intended for publication. Marketing pages, blog posts, career and occupation
guides, certification and learning content, pricing, legal and policy text.

**Controls:** integrity only. This is the CMS's domain.

## Applying the classification
1. Every new table declares a classification in its migration.
2. Logging middleware redacts `CONFIDENTIAL` and drops `RESTRICTED`.
3. The AI gateway rejects any payload containing a `RESTRICTED` field.
4. Analytics marts carry the highest classification of their inputs.
5. Retention is driven by classification (`DATA_RETENTION_MATRIX.md`).
6. An unclassified field is treated as `CONFIDENTIAL` until classified — the safe
   default.
