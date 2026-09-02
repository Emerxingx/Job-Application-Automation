# ADR-0015 — Data residency

**Status:** Proposed · **Date:** 2026-09-02

## Context
The product handles Canadian personal information: candidate profiles, résumés,
employment history, work authorisation, mailbox content (Stage 11), and — in the
WorkBC product — **employment-services case notes**, which are among the most
sensitive records the platform will hold.

BC public-sector data-handling expectations are materially stricter than the
commercial default, and a service-provider buyer will ask where data lives before
anything else. PIPEDA applies federally; BC has its own regime for public bodies
and their service providers.

## Decision
**Personal data is stored and processed in Canada by default.**

- Primary transactional database: managed PostgreSQL in a **Canadian region**
  (Supabase Canada Central at founder stage, per the target baseline).
- Object storage: Canadian region, encrypted at rest, private by default,
  access via signed expiring URLs.
- Backups and point-in-time recovery: Canadian region.
- The Payload CMS database sits on the same Canadian instance.

**Documented exceptions**, each recorded in `COMPLIANCE_REGISTER.md` with its
data category, purpose, safeguard and the consent that covers it:

- **AI providers.** Anthropic and OpenAI process prompt content outside Canada.
  This is a genuine cross-border transfer and must be disclosed in the privacy
  policy and consented to. Mitigations: send **evidence references and minimal
  necessary content**, never whole profiles; never send sensitive attributes
  (`ADR-0007`); never send mailbox content without explicit consent (Stage 11).
- **Stripe.** Payment processing is cross-border by nature. No card data is
  stored by the platform.
- **Job sources.** Outbound queries carry search criteria, not candidate identity.

## Per-tenant AI processing policy

Cross-border AI processing is **not universally permissible** and must not be
treated as a platform-wide constant. Each organisation carries an explicit,
governed AI processing policy:

| State | Meaning |
| --- | --- |
| `EXTERNAL_AI_ALLOWED` | Approved cross-border providers may process this tenant's data, under the applicable consent, contract and privacy controls |
| `EXTERNAL_AI_RESTRICTED` | External processing permitted only for named data categories and named tasks; everything else stays inside the permitted boundary |
| `EXTERNAL_AI_PROHIBITED` | **No** tenant data may leave the permitted processing boundary |

Commercial tenants may sit at `EXTERNAL_AI_ALLOWED`. **Public-sector, WorkBC and
other restricted tenants must be able to select `EXTERNAL_AI_PROHIBITED`, and the
platform must remain usable for them.**

Under `EXTERNAL_AI_PROHIBITED`, none of the following may leave the permitted
processing boundary, in any form, including embeddings and derived
classifications:

- candidate career evidence
- case notes, assessments or employment plans
- mailbox or calendar content
- any `RESTRICTED` tenant data

The provider abstraction must therefore support, per tenant and per task:

1. **deterministic / local processing** — the existing deterministic engine, which
   is why it is retained permanently;
2. a **future Canadian-resident provider**;
3. an **approved private or on-shore provider**;
4. **explicit feature degradation** where no compliant processor exists — the
   feature is disabled and says so, rather than silently falling back to a
   non-compliant path.

**Enforcement is in the AI gateway, not in calling code.** The gateway resolves
the tenant's policy before dispatch and refuses a non-compliant route. A missing
or unreadable policy **fails closed** to `EXTERNAL_AI_PROHIBITED`. Every `ai_runs`
record stores the policy state and the route actually taken, so compliance is
auditable after the fact.

**L-3 remains OPEN** (`COMPLIANCE_REGISTER.md`) until legal and privacy review
establishes actual customer requirements. This policy mechanism is what makes the
architecture safe while that question is unresolved — it does not answer it.

**The WorkBC product may require stricter handling than the commercial default.**
Design for a per-organisation residency and retention policy rather than assuming
one global setting, and treat a service-provider contract as capable of
overriding platform defaults.

## Consequences
- Region choice is made once, early, and is expensive to reverse. It sequences in
  Stage 01 with the PostgreSQL migration.
- Every third-party processor is inventoried in `INTEGRATION_REGISTER.md` with
  its data categories and residency.
- An AI provider without a Canadian processing option is a considered exception,
  not an oversight — recorded as such, and unavailable to any tenant at
  `EXTERNAL_AI_PROHIBITED`.
- The per-tenant AI processing policy is a **Stage 01 schema obligation** (it is
  an organisation attribute) and a **Stage 03 enforcement obligation** (the
  gateway must honour it before evidence-grounded generation goes live).
- Enterprise or public-sector tenants may require physical isolation; `ADR-0005`
  anticipates this.

## Revisit when
A public-sector contract mandates in-province processing, or an AI provider
offers Canadian residency.
