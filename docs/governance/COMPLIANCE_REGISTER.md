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
| Anthropic | Prompt content — evidence references, minimal necessary; **never `RESTRICTED`** | AI generation and analysis | Disclosed in privacy policy; consented; minimised; gateway rejects restricted payloads; **gated by the tenant's AI processing policy — unavailable at `EXTERNAL_AI_PROHIBITED`** (`ADR-0015`) |
| OpenAI (planned) | As above | As above | As above |
| Stripe | Email, amounts, metadata. **No card data stored** | Payment processing | Industry-standard; PCI handled by Stripe |
| PayPal | Payment data | Alternative gateway | As above |

Every processor is inventoried in `INTEGRATION_REGISTER.md` with its data
categories and residency.

## Data residency — primary store and identity (`ADR-0015`)

| Item | State | Evidence | Recorded |
| --- | --- | --- | --- |
| Transactional database region | **Canada (Central), AWS `ca-central-1`** | Founder attestation — the project was provisioned there | 2026-09-02 |
| Supabase Auth records | **Same region as the project database**, in the project's Postgres `auth` schema | Founder attestation, citing Supabase's regions and Auth documentation | 2026-09-02 |
| Supabase Auth technical residency gate | **SATISFIED** | `../programme/AUTH_DECISION_GATE.md` §6 | 2026-09-02 |
| Verified independently by engineering | **NO** | `supabase.com` is blocked by this environment's egress proxy; the claim is recorded as an attestation, not as a measurement | — |
| Region confirmed from the provisioned project itself | **PARTIAL** — confirmed from the **connection endpoint** (the pooler host of the provisioned credential is `aws-0-ca-central-1.pooler.supabase.com`, read from the variable's shape without printing it); **not** from a live query, because the project is unreachable from the build environment (R-34) | `AUTH_DECISION_GATE.md` §6.5 names the endpoint as an acceptable source; a live `SELECT` remains outstanding | 2026-09-03 |
| Consent capture | **IMPLEMENTED** — explicit, versioned, revocable records (`ConsentRecord`) for Terms of Service and Privacy Policy at signup; each grant and revocation audited | `src/lib/consent.ts`; the document **wording** is pending counsel (R-36, L-5) | 2026-09-03 |

### What this settles, and what it does not

It settles the **technical** question `ADR-0015` asks of the primary store and of
identity: both sit in Canada. That was the open blocker on the Stage 01
authentication decision, which is now ratified.

It settles **nothing legal**. Recorded verbatim from the founder's instruction of
2026-09-02:

> This does NOT resolve the separate WorkBC/public-sector legal/compliance
> question regarding subprocessors, cross-border processing, or contractual
> requirements. Keep those public-sector/legal items OPEN in the compliance
> register until counsel resolves them. Do not treat this technical gate as legal
> approval for WorkBC/public-sector deployment.

Accordingly **`L-1` and `L-3` below remain OPEN**, and **Product 3 (Employment
Services / WorkBC Case Manager OS) must not be deployed to a public-sector
customer on the strength of this section.** Region is where bytes sit. It is not
a subprocessor assessment, a cross-border processing assessment, or a contract.

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

## OPEN LEGAL / COMPLIANCE DECISIONS — REQUIRES LEGAL OR FOUNDER DECISION

These five questions are **OPEN**. They are **not engineering facts** and must not
be answered, inferred or assumed by engineering. Each is recorded with its exact
decision owner and the latest stage by which it must be resolved.

**None of the five blocks completion of the architecture baseline.** Each was
assessed against the question the audit brief poses — does it make the proposed
architecture technically unsafe or impossible? — and the answer in every case is
no, because the architecture is deliberately built to accommodate either outcome.
The reasoning per question is in the "Why it does not block the baseline" column.

| # | Open question | Status | Decision owner | Must be resolved by | Why it does not block the baseline |
| --- | --- | --- | --- | --- | --- |
| **L-1** | Does the WorkBC engagement make the platform a **service provider to a public body**, and which regime applies (BC FIPPA vs BC PIPA vs PIPEDA)? | **OPEN — REQUIRES LEGAL DECISION** | **Founder + external BC public-sector privacy counsel** | **Stage 17** (Employment Services / WorkBC OS). *Architecture-shaping input needed by Stage 01,* because residency and per-organisation retention are set there | `ADR-0015` already makes residency and retention **per-organisation policy** rather than a global constant, so a stricter answer tightens configuration, not design. `ADR-0020` ships the product at Level 0 with no integration |
| **L-2** | Which Canadian taxonomy datasets (**NOC, TEER, OaSIS, Canadian Skills and Competencies Taxonomy**) may be redistributed within a commercial product, and on what attribution terms? | **OPEN — REQUIRES LEGAL DECISION** | **Founder + IP / data-licensing counsel** | **Stage 04** (Canada occupation & skills taxonomy) — **before any dataset is ingested** | `ADR-0009` keys every occupation on an internal canonical id with jurisdiction codes as attributes, so a dataset that cannot be redistributed is replaced or degraded without a schema change. `SOURCE_ACCESS_POLICY.md` blocks ingestion until the licence is recorded |
| **L-3** | Are the **cross-border AI transfers** (Anthropic, OpenAI) acceptable under the intended customer contracts, particularly public-sector ones? | **OPEN — REQUIRES LEGAL DECISION.** Stage 03 (2026-09-03) built the enforcement so that nothing crosses the border today: the gateway resolves each tenant's policy before dispatch, `RESTRICTED` permits no task, and no prompt version is deployed as default. **Stage 03's exit is BLOCKED on this row**; the decision, once made, is recorded here and enabled by an operator promotion, not a code change | **Founder + privacy counsel** | **Stage 03** (evidence-grounded generation — the first commitment to sending candidate evidence to a provider). **Re-confirmation required at Stage 11** (mailbox content) **and Stage 17** (public-sector tenants) | The provider abstraction and the `ADR-0006` gateway make the provider an adapter, so a Canadian-resident or on-shore provider is a swap, not a redesign. `ADR-0007` already bars `RESTRICTED` data from every prompt, and the gateway rejects such payloads |
| **L-4** | What **recruiter / staffing licensing** applies in BC and in each target jurisdiction? | **OPEN — REQUIRES LEGAL DECISION** | **Founder + employment / regulatory counsel** | **Stage 19** (Staffing / Placement OS) | The brief's own requirement — jurisdictional rules as configuration, never hardcoded Canadian globals — is already the Stage 19 design, so the answer populates a rule set rather than altering one |
| **L-5** | What **consent language** is required for candidate representation by an agency, and for disclosure to an employer? | **OPEN — REQUIRES LEGAL/FOUNDER DECISION** | **Founder + employment / privacy counsel** | **Stage 18** (employer disclosure consent — before any candidate is disclosed to an employer). Agency-representation consent by **Stage 19** | Consent is already modelled as explicit, granular, versioned and revocable, and disclosure is consent-gated by construction (`ROLE_PERMISSION_MATRIX.md`). The open question is the **wording and scope** of a consent record, not whether one exists |

### Rules for these five
1. They remain **OPEN** until the named owner records a decision here, with a date.
2. Engineering must **not** invent an answer, and must not treat an unresolved
   question as a settled fact in code, documentation or marketing.
3. A stage whose "must be resolved by" date has arrived with the question still
   open is **BLOCKED** at its exit gate, not permitted to proceed on an assumption.
4. Resolving a question is recorded here **and** in `DECISION_REGISTER.md`; if it
   changes an architectural decision it also requires a new or superseding ADR.
5. Tracked in `RISK_REGISTER.md` as **R-25 … R-29**.
