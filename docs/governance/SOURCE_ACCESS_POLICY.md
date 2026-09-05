# Source Access Policy

Governs how the platform acquires job and labour-market data. Binding on every
connector.

## Priority order
1. **Authorized APIs** — a documented API with terms permitting this use.
2. **Authorized feeds** — a licensed or approved data feed.
3. **Legitimate public ATS posting interfaces** — Greenhouse, Lever, Ashby,
   SmartRecruiters public job endpoints, used as documented.
4. **Structured employer career pages** — where terms permit.
5. **Licensed aggregation providers** — under contract.
6. **Permitted crawling** — only where robots and terms allow, rate-limited and
   identified.

A lower priority is used only when no higher one is available for that source.

## Absolute prohibitions
These are architectural boundaries, not preferences. A connector proposing any of
them is rejected at review:

- **CAPTCHA bypass or solving.**
- **Access-control circumvention** — authentication bypass, paywall evasion,
  session reuse without authorization.
- **Browser-fingerprint evasion** designed to appear as a different client.
- **Proxy or IP-rotation infrastructure whose purpose is defeating restrictions.**
- Ignoring `robots.txt` where it governs the access in question.
- Automated submission to any destination whose terms prohibit it
  (`ADR-0016`).

## Job Bank
**No prohibited scraping.** Architect around permitted open datasets, approved
public data, and authorized feed access **if and when** qualification and approval
exist. **No fabricated real-time Job Bank access**, in code, in the UI, or in
marketing material.

## Per-connector record
Before any connector is enabled, this table is completed:

| Field | Requirement |
| --- | --- |
| Source name | |
| Legal basis | API terms, licence, contract, or documented permission |
| Terms reviewed | Date and reviewer |
| `robots.txt` position | Where crawling is involved |
| Rate limits | Documented and enforced in code |
| Attribution required | And where it is displayed |
| Data categories | What is retrieved |
| Personal data | Whether any is present |
| Retention | Per `DATA_RETENTION_MATRIX.md` |
| Approval | Who approved enablement, and when |

**Enforced in code since Stage 05 (2026-09-03).** Every connector has a
`JobSource` row (`src/lib/connectors/registry.ts`); `requireEnabledSource()`
is the only way the pipeline obtains a connector, and it refuses a source that
is disabled, whose record is incomplete (legal basis, terms review, approval,
retention reference) or whose credentials are absent — each refusal is itself
a recorded run. Recording and enabling are admin actions at `/console/sources`,
step-up re-authenticated and audited. Credentials are referenced by
environment-variable NAME only.

| Field | Built-in synthetic catalogue (`mock`) | Adzuna (`adzuna`) |
| --- | --- | --- |
| Source name | Built-in synthetic catalogue | Adzuna search API |
| Legal basis | Synthetic data shipped in the repository; no external access, no third-party terms | **UNRECORDED** — the API terms have not been reviewed; the field is empty in the register and stays so until a person records it |
| Terms reviewed | not applicable (recorded as "repository") | — |
| `robots.txt` position | not applicable — no network access | not applicable — documented API, no crawling |
| Rate limits | none | **to record** from the API terms; enforced by the adapter's call cap (5 titles × 3 locations per search) until then |
| Attribution required | no | **yes** (the API terms require it); text to record |
| Data categories | synthetic postings | job postings (CA/US): title, company, location, snippet description, salary where stated, apply link |
| Personal data | none | none retrieved (postings only; queries carry search criteria, never candidate identity) |
| Retention | `DATA_RETENTION_MATRIX.md` — Job postings & snapshots | same |
| Approval | enabled by default (the reason a clean clone boots); recorded as "repository" | **none** — `disabled`; enabling requires the record above and `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` present |
| Validation status | not applicable | `IMPLEMENTED-NOT-VALIDATED`: contract suite passed on a recorded-shape fixture; **never called with a live key** |

## Taxonomy licensing
NOC, TEER, OaSIS, the Canadian Skills and Competencies Taxonomy and O*NET each
carry distinct terms. **No dataset is ingested before its licence and attribution
obligations are recorded here.** Attribution is surfaced in the product where
required.

**Enforced in code since Stage 04 (2026-09-03).** Every dataset has a
`TaxonomyDataset` row (`src/lib/taxonomy/datasets.ts`); its `licenceStatus`
starts `unrecorded`, and the loaders obtain a dataset only through
`requireIngestible()`, which refuses anything not `recorded` with ingestion
approved. Recording is an admin action at `/console/taxonomy`, requires the
attribution text the product will display and a reason, and writes an audit
row (`taxonomy.licence.recorded`). A `prohibited` decision can never be
loaded, and recording it — or withdrawing approval — on a dataset that has
been loaded purges its rows in the same transaction: the gate covers what is
already in the database, not only what is about to enter it, and each load
is one transaction. The attribution is shown on any job page whose occupation came from that
dataset.

| Dataset | Publisher | What the publisher states (to be CONFIRMED by counsel — L-2) | Record status |
| --- | --- | --- | --- |
| NOC 2021 V1.0 | Statistics Canada / ESDC | Open Government Licence – Canada: copy, modify, redistribute with attribution | **unrecorded** — not ingested |
| SOC 2018 | U.S. Bureau of Labor Statistics | U.S. federal work, public domain in the U.S. | **unrecorded** — not ingested |
| OaSIS | ESDC | Government of Canada content; terms to confirm | **unrecorded** — not ingested |
| Canadian Skills and Competencies Taxonomy | ESDC | Government of Canada content; terms to confirm | **unrecorded** — not ingested |
| O*NET | U.S. DOL / National Center for O*NET Development | CC BY 4.0 with a required attribution statement | **unrecorded** — not ingested |
| Test fixture | this repository | a dozen hand-written nodes in NOC's shape, attributed (`tests/fixtures/README-taxonomy.md`) | approvable only inside a test database |
| Job Bank regulated occupations and certification requirements (Stage 16) | ESDC (Job Bank) | Government of Canada material; redistribution terms and attribution wording to confirm | **unrecorded** — not ingested |
| CICIC directory of institutions and programs (Stage 16) | CMEC / CICIC | published for public information; redistribution and the recognition claims it carries need review | **unrecorded** — not ingested |
| Learning-graph test fixture (Stage 16) | this repository | hand-written credentials, providers and offerings; every recognition value is what the file states (`tests/fixtures/learning-fixture.json`) | approvable only inside a test database |

The "what the publisher states" column is what a developer read on the
publisher's site. It is not a licence record and grants nothing: the row
turns `recorded` only when a person with the review in hand records it.

## Outbound data
Queries to job sources carry **search criteria only — never candidate identity**.
A source must not be able to profile the platform's candidates from its query log.

## Review
Terms change. Every connector's legal basis is re-reviewed annually, or on notice
of a terms change, and the review is recorded above.
