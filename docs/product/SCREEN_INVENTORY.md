# Screen Inventory

Status: **BUILT** (exists at `35d3491`) · **PARTIAL** · **PLANNED**
27 pages exist today. They are listed against their target position so nothing
built is rebuilt.

## Public
| Screen | Status |
| --- | --- |
| Landing / marketing (CMS-driven, falls back to built-in copy) | **BUILT** |
| Pricing | PARTIAL (`PricingCopy` global exists) |
| Resources / blog (`BlogPosts`) | PARTIAL |
| Career content / occupation guides (`CareerGuides`) | PARTIAL |
| Certification guides (`Certifications`) | PARTIAL |
| Learning content (`LearningPaths`) | PARTIAL |
| Employer pages · partner pages · FAQ/help · legal & policy | PLANNED |

## Candidate (P1)
| Screen | Status |
| --- | --- |
| Signup / login | **BUILT** |
| Email verification · MFA setup · account recovery · device & session list | PLANNED |
| Onboarding | **BUILT** (needs Digital Twin expansion) |
| Dashboard | **BUILT** (CMS-configurable layout) |
| Job search & agents · new agent | **BUILT** |
| Recommendations feed | PARTIAL |
| Job list / job detail | **BUILT** |
| **Match analysis** (dimensions, evidence, gaps, risks) | PARTIAL — needs eligibility + evidence |
| **Eligibility detail** (pass/fail with reasons) | PLANNED |
| Résumé (master + versions) | PARTIAL — no version history |
| Cover letters | PARTIAL |
| **Career Evidence Vault** | PLANNED |
| **Application question bank** | PLANNED |
| Applications list / detail | **BUILT** |
| **Job Folder** (canonical record) | PARTIAL — ~15 of ~30 fields |
| Documents | **BUILT** |
| Emails / communication | PLANNED |
| Interviews | PLANNED |
| Interview prep | **BUILT** |
| Career (transition, options, comparison, pathway, skills gap) | PLANNED |
| Learning (path, certifications, progress) | PLANNED |
| Billing · invoices | **BUILT** |
| Profile · settings | **BUILT** |
| **Privacy & consent centre** | PLANNED |
| Integrations | **BUILT** |
| Analytics | **BUILT** |

## Talent / Employer (P2) — all PLANNED
Employer dashboard · clients · requisitions · jobs · candidate search · talent
pool · candidate profile (consent-gated) · submission · pipeline · interviews ·
offers · placements · reports · billing · settings.

## Employment services (P3) — all PLANNED
Organisation dashboard · caseload · client record · assessment · employment plan ·
job recommendations · applications · résumé · case notes · interventions ·
training referrals · outcomes · retention · reports · administration.

## Career / Learning (P4) — all PLANNED
Assessment · career options · career comparison · career pathway · skills gap ·
learning path · certifications · progress.

## Admin
| Screen | Status |
| --- | --- |
| Payload CMS admin (`/admin`) | **BUILT** |
| Staff console — customers, invoices, revenue, tickets (`/console`) | **BUILT** |
| Users · organisations · roles · permissions | PLANNED |
| Plans · pricing · subscriptions · entitlements | PARTIAL |
| Job sources · connectors · health | PLANNED |
| AI models · **prompt registry** | PARTIAL — in CMS, moves to admin (`ADR-0019`) |
| Matching weights | PLANNED |
| Taxonomies (NOC, skills, industries) | PLANNED |
| Career data · learning catalog | PLANNED |
| Feature flags | PLANNED (model exists, unused) |
| Notifications · email templates | PLANNED |
| Retention · privacy · audit | PLANNED |
| Reports · integration health · platform health | PARTIAL |

## Mobile (V1) — all PLANNED
Candidate-centric: recommendations · job detail · match analysis · applications ·
Job Folder · interviews · notifications · light profile edit.
**Excluded from v1:** document editing, billing, employer, case management, admin.

## Cross-cutting requirements
Every screen: WCAG 2.2 AA (Stage 23) · responsive · bilingual-ready EN/FR
(`ADR-0009`) · **no sensitive demographic data displayed in any matching,
ranking or recommendation context** · loading, empty, error and permission-denied
states specified rather than improvised.
