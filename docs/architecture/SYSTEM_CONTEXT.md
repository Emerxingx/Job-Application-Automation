# System Context

## Actors

| Actor | Product | Relationship |
| --- | --- | --- |
| Candidate / job seeker | P1, P4 | Owns their digital twin, evidence and consent |
| Employer hiring manager | P2 | Member of an employer organisation |
| Recruiter / TA specialist | P2 | Member of an employer organisation |
| Agency recruiter | P2, P3(staffing) | Member of a staffing agency; represents candidates with consent |
| Agency owner / operations | Staffing | Contracts, fees, placements, invoicing |
| WorkBC case manager | P3 | Member of a service provider; assigned a caseload |
| Case-manager supervisor | P3 | Oversees caseload and outcomes |
| Career consultant | P4 | Delivers transition and learning services |
| Platform staff (support, billing ops, admin) | All | Gated by the two-lock console rule |
| Founder / platform owner | All | Operates the business from admin surfaces |

## External systems

| System | Direction | Purpose | Current status |
| --- | --- | --- | --- |
| Adzuna | in | Job aggregation (CA/US) | IMPLEMENTED-NOT-VALIDATED |
| Greenhouse / Lever / Ashby / SmartRecruiters | in/out | ATS postings; authorized submission | Detection implemented; submission unvalidated |
| Employer career pages | in | Structured postings | Planned |
| Job Bank | in | Canadian public postings | **Not implemented.** Permitted datasets / approved feeds only (`ADR-0008`) |
| NOC / TEER / OaSIS / Skills taxonomy | in | Occupational spine | Planned, licence-gated (`ADR-0009`) |
| O*NET / SOC | in | US occupational data | Planned, licence-gated |
| Anthropic / OpenAI | out | AI gateway | Anthropic implemented, unvalidated. Cross-border (`ADR-0015`) |
| Stripe | out/in | Billing, tax, webhooks | IMPLEMENTED-NOT-VALIDATED |
| PayPal | out/in | Alternative gateway | IMPLEMENTED-NOT-VALIDATED |
| Gmail / Microsoft Graph | in/out | Communication intelligence | Not implemented (Stage 11) |
| Google / Microsoft Calendar | in/out | Interview scheduling | Not implemented |
| Google / Microsoft / Apple identity | in | OAuth sign-in | Not implemented (`ADR-0004`) |
| Enterprise IdP (SAML/OIDC) | in | Tenant SSO | Not implemented (Stage 20) |
| S3-compatible storage | out | Documents, folders, uploads | Not implemented — local filesystem today |
| WorkBC systems | — | **No integration** | Level 0 (`ADR-0020`) |

## Trust boundaries

1. **Public internet → application.** Every request authenticated at the edge
   (`middleware.ts`, Stage 01) and again in the handler.
2. **Application → database.** RLS enforces tenancy independently of application
   code (`ADR-0005`).
3. **Application → sensitive schema.** A separate grant the matching and AI paths
   do not hold (`ADR-0007`).
4. **Application → AI provider.** Cross-border. Minimal necessary content,
   evidence references not raw profiles, never sensitive attributes.
5. **Application → job sources.** Outbound carries search criteria, never
   candidate identity.
6. **Customer-supplied webhook URLs → outbound HTTP.** SSRF-guarded, no redirect
   following (implemented; residual DNS-rebinding gap documented).
7. **CMS ↔ transactional store.** No shared tables, no shared credentials, in
   either direction.
8. **Staff console → customer data.** Two-lock gate; read-only, reason-required,
   time-boxed impersonation (Stage 20).
