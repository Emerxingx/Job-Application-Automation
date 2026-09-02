# Compliance Register

**Not legal advice.** This records obligations the architecture must support and
where each is addressed. Legal review is required before production and before
each product's launch.

## Privacy

| Regime | Applies to | Architectural obligation | Where addressed |
| --- | --- | --- | --- |
| **PIPEDA** (federal) | Commercial handling of personal data in Canada | Consent, access, correction, erasure, breach notification, accountability | `DATA_CLASSIFICATION.md`, `DATA_RETENTION_MATRIX.md`, existing scrub-in-place erasure |
| **BC PIPA** | BC private-sector organisations | Comparable to PIPEDA; BC-specific consent rules | Consent model, Stage 01 |
| **BC FIPPA** | BC public bodies **and their service providers** | Stricter handling; data-residency expectations; access and retention obligations | `ADR-0015`, `ADR-0020`, per-organisation retention |
| **GDPR** | Any EU data subject | Lawful basis, portability, erasure, DPIA | Consent + retention; **out of scope until an EU user is accepted** |
| **Provincial employment standards** | Recruitment and staffing | Jurisdictional rules must be configuration | Stage 19 |

**Key exposure:** the WorkBC product means the platform may act as a **service
provider to a public body**, which imports FIPPA-adjacent obligations that exceed
the commercial default. This is why per-organisation residency and retention
policy is an architectural requirement rather than a feature.

## Employment and human rights

| Obligation | Requirement | Where |
| --- | --- | --- |
| Non-discrimination (federal + provincial human rights codes) | Protected characteristics must not influence matching, ranking or recommendation | `ADR-0007` — physical schema separation, no grants on decision paths |
| Voluntary self-identification | Collected voluntarily, stored separately, used only for aggregate reporting | `sensitive.*` schema |
| Employment-equity reporting | Aggregate only, with small-cohort suppression | `REPORTING_ARCHITECTURE.md` |
| Work authorization | Operationally relevant to eligibility; access-controlled and audited | Stage 07 |
| Recruiter/staffing licensing | Jurisdiction-specific; must not be hardcoded globally | Stage 19 |

## Cross-border transfers (documented exceptions to `ADR-0015`)

| Processor | Data | Purpose | Safeguard |
| --- | --- | --- | --- |
| Anthropic | Prompt content — evidence references, minimal necessary; **never `RESTRICTED`** | AI generation and analysis | Disclosed in privacy policy; consented; minimised; gateway rejects restricted payloads |
| OpenAI (planned) | As above | As above | As above |
| Stripe | Email, amounts, metadata. **No card data stored** | Payment processing | Industry-standard; PCI handled by Stripe |
| PayPal | Payment data | Alternative gateway | As above |

Every processor is inventoried in `INTEGRATION_REGISTER.md` with its data
categories and residency.

## Payments and financial
No card data stored — Stripe holds it. Invoice retention 7 years. Tax
determination via Stripe Tax plus the existing registration and collection-policy
engine. Tax is **not collected where the business is not registered** — an
existing, correct behaviour in `src/lib/billing/tax.ts`.

## Accessibility
WCAG 2.2 AA is the target (Stage 23). **Not currently tested — status
`NOT VERIFIED`.** Public-sector buyers will require conformance evidence, so this
is a sales blocker for the WorkBC product, not only a quality goal.

## Terms of service compliance
Governed by `SOURCE_ACCESS_POLICY.md` and `ADR-0016`. No automated submission to
destinations whose terms prohibit it; no circumvention of any access control.

## Outstanding legal questions (founder / counsel — not resolvable by engineering)
1. Does the WorkBC engagement make the platform a service provider to a public
   body, and which regime applies?
2. Which Canadian taxonomy datasets may be redistributed within a commercial
   product, and on what attribution terms?
3. Are the cross-border AI transfers acceptable under the intended customer
   contracts, particularly public-sector ones?
4. What recruiter/staffing licensing applies in BC and each target jurisdiction?
5. What consent language is required for candidate representation by an agency,
   and for disclosure to an employer?
