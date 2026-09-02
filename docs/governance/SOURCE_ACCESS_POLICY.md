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

## Outbound data
Queries to job sources carry **search criteria only — never candidate identity**.
A source must not be able to profile the platform's candidates from its query log.

## Review
Terms change. Every connector's legal basis is re-reviewed annually, or on notice
of a terms change, and the review is recorded above.
