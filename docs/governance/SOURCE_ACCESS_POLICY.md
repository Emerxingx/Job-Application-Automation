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

*(No connector is currently enabled under this policy. Adzuna is implemented but
unvalidated and its record must be completed in Stage 05.)*

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
loaded. The attribution is shown on any job page whose occupation came from
that dataset.

| Dataset | Publisher | What the publisher states (to be CONFIRMED by counsel — L-2) | Record status |
| --- | --- | --- | --- |
| NOC 2021 V1.0 | Statistics Canada / ESDC | Open Government Licence – Canada: copy, modify, redistribute with attribution | **unrecorded** — not ingested |
| SOC 2018 | U.S. Bureau of Labor Statistics | U.S. federal work, public domain in the U.S. | **unrecorded** — not ingested |
| OaSIS | ESDC | Government of Canada content; terms to confirm | **unrecorded** — not ingested |
| Canadian Skills and Competencies Taxonomy | ESDC | Government of Canada content; terms to confirm | **unrecorded** — not ingested |
| O*NET | U.S. DOL / National Center for O*NET Development | CC BY 4.0 with a required attribution statement | **unrecorded** — not ingested |
| Test fixture | this repository | a dozen hand-written nodes in NOC's shape, attributed (`tests/fixtures/README-taxonomy.md`) | approvable only inside a test database |

The "what the publisher states" column is what a developer read on the
publisher's site. It is not a licence record and grants nothing: the row
turns `recorded` only when a person with the review in hand records it.

## Outbound data
Queries to job sources carry **search criteria only — never candidate identity**.
A source must not be able to profile the platform's candidates from its query log.

## Review
Terms change. Every connector's legal basis is re-reviewed annually, or on notice
of a terms change, and the review is recorded above.
