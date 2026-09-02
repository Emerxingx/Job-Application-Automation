# ADR-0008 — Job acquisition: lawful-source-only connector framework

**Status:** Proposed · **Date:** 2026-09-02

## Context
Existing: a `JobProvider` interface with two methods (`search`, `submit`), one
real adapter (Adzuna, `IMPLEMENTED-NOT-VALIDATED`), a mock, and ATS detection for
Greenhouse and Lever. The Adzuna adapter is well-written and honest about upstream
limits (snippet-length descriptions, no NOC code — inferred where possible, left
undefined otherwise rather than guessed).

The target requires eight methods including `detectClosed()`, `refresh()`,
`healthCheck()` and `getApplicationRoute()`.

## Decision
Expand `JobProvider` into **`JobSourceConnector`**:

```
discover() fetch() normalize() validate() refresh() detectClosed()
getApplicationRoute() healthCheck()
```

**Source priority, strictly ordered:**
1. Authorized APIs
2. Authorized feeds
3. Legitimate public ATS posting interfaces (Greenhouse, Lever, Ashby, SmartRecruiters)
4. Structured employer career pages
5. Licensed aggregation providers
6. Permitted crawling, where terms allow

**Prohibited, without exception:** CAPTCHA bypass, access-control circumvention,
browser-fingerprint evasion, and proxy infrastructure whose purpose is defeating
restrictions. This is a hard architectural boundary, not a preference. A
connector proposing any of these is rejected at review.

**Job Bank:** no prohibited scraping. Design around permitted open datasets,
approved public data, and authorized feed access if and when qualification and
approval exist. **No fabricated real-time Job Bank access.**

## Consequences
- Every connector records its legal basis, robots/ToS position, rate limits and
  credential requirements in `docs/governance/SOURCE_ACCESS_POLICY.md` **before**
  it is enabled.
- A connector contract test suite is the admission gate — every adapter passes
  the same suite.
- Connector health is a first-class admin surface (`ADR-0019`).
- Adzuna must be validated against the live API in Stage 05 before it can be
  described as production-ready anywhere.
- `getApplicationRoute()` feeds the apply engine's channel decision
  (`ADR-0016`) — ATS API where authorized, assisted everywhere else.

## Revisit when
A licensed aggregation contract or a Job Bank feed approval changes what is
lawfully available.
