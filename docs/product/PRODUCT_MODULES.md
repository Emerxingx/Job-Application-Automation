# Product Modules and Scope Boundaries

Scope classes: **MVP** · **V1** · **V2** · **ENTERPRISE**.
Not everything is MVP. The MVP is the smallest credible vertical slice usable by
real candidates **without compromising the long-term architecture**.

## MVP — Candidate Job Search OS, thin but real

**Goal:** a real candidate runs a real job search end-to-end, with real
(non-mock) job data, and gets tailored, truthful documents they submit
themselves.

| Module | MVP content |
| --- | --- |
| Identity | Email/password, **email verification**, revocable sessions, MFA available, password recovery |
| Tenancy | One identity, memberships modelled; candidate-only surfaces active |
| Digital Twin | Structured profile: employment history, education, skills, certifications, preferences, work authorization |
| Evidence Vault | Evidence capture and approval; **grounding enforced in generation** |
| Taxonomy | NOC/TEER occupations, skills taxonomy, Canadian geography |
| Job sources | ≥2 lawful connectors, **Adzuna validated live** |
| Normalization | Canonical job, dedup, freshness, closure detection |
| Eligibility | Hard gates with reasons |
| Compatibility | Full pipeline with dimension breakdown and explanation |
| Documents | Tailored résumé + cover letter, PDF **and DOCX**, versioned, immutable submitted copies |
| Apply | Prepare + Review & Submit; assisted apply; ATS API where authorized |
| Job Folder | Canonical record per application, durable storage |
| Analytics | Applications, responses, interviews, rates |
| Billing | Candidate subscription, **Stripe validated**, entitlement layer |
| Admin | Plans, prices, entitlements, job sources, users, feature flags |
| Platform | PostgreSQL + migrations, RLS, CI, workers, patched Next |

**Explicitly not in MVP:** email/calendar intelligence, mobile, employer product,
staffing, case management, career-transition engine, auto-apply.

## V1 — Candidate depth + the fourth product

Email and calendar intelligence (Stage 11) · candidate mobile app (Stage 14) ·
**Career Change / Learning / Certification OS** (Stage 16) · richer candidate
analytics · browser extension for assisted apply · interview preparation depth.

Career Change is V1 rather than V2 because it is the strongest differentiator and
reuses the MVP taxonomy and eligibility engine rather than requiring new
foundations.

## V2 — The organisational products

**Employment Services / WorkBC OS** (Stage 17, Level 0 integration) ·
**Corporate / Talent Acquisition OS** (Stage 18) ·
**Staffing / Placement OS** (Stage 19) · advanced reporting and marts (Stage 21).

WorkBC precedes Corporate deliberately: it is a clearer buyer, a smaller
competitive field, and a strong Canadian anchor — and its isolation and audit
requirements harden the tenancy model before the employer product depends on it.

## ENTERPRISE

SSO (SAML/OIDC) and SCIM · tenant-level policy, residency and retention · advanced
audit and compliance reporting · warehouse extraction · public-sector readiness ·
white-label · API partner programme.

## Gated indefinitely

**Approved Auto-Apply** (Stage 22) — blocked pending lawfulness confirmation,
consent design, and an explicit written founder decision with legal review.
**Interview probability** — not modelled until real outcome data supports
calibration.

## The boundary that must hold
Every MVP module is built on the platform core — tenancy, consent, evidence,
taxonomy, eligibility, entitlement, events, audit. Nothing in the MVP is a
candidate-only shortcut that the other three products would later have to unpick.
That constraint is what makes the MVP small without making it disposable.
