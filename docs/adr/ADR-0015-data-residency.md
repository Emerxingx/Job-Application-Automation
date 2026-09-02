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
  not an oversight — recorded as such.
- Enterprise or public-sector tenants may require physical isolation; `ADR-0005`
  anticipates this.

## Revisit when
A public-sector contract mandates in-province processing, or an AI provider
offers Canadian residency.
