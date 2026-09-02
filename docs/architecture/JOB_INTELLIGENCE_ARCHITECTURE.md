# Job Intelligence Architecture

**Decisions:** `../adr/ADR-0008-job-acquisition.md`, `../adr/ADR-0009-canada-taxonomy.md`

## Pipeline

```
 SOURCES ─► discover ─► fetch ─► normalize ─► validate ─► deduplicate ─► ENRICH
                                                                          │
                     ┌────────────────────────────────────────────────────┘
                     ▼
   CANONICAL JOB ─► ELIGIBILITY (hard pass/fail) ─► COMPATIBILITY (scored)
                          │                                │
                     reasons, not scores          dimensions + evidence
                                                          │
                                                    RECOMMENDATION
                                                   (with explanation)
```

Freshness runs continuously alongside: `refresh()` and `detectClosed()` keep
`last_seen`, `active_state` and `closed_at` honest.

## Connector contract
```
discover() fetch() normalize() validate() refresh() detectClosed()
getApplicationRoute() healthCheck()
```
Every adapter passes one shared contract suite before it may be enabled.
Source priority and the absolute prohibitions (no CAPTCHA bypass, no
access-control circumvention, no fingerprint evasion, no restriction-defeating
proxies) are in `ADR-0008` and `../governance/SOURCE_ACCESS_POLICY.md`.

## Canonical job
Per §10 of the brief, including the fields absent today: `normalized_title`,
`occupation_family`, NOC **and** SOC, `postal_region`, `first_seen`, `last_seen`,
`active_state`, `closed_at`, `source_hash`, `canonical_hash`, separated
`required_skills` / `preferred_skills`, education, certification and experience
requirements, language, `work_authorization`, `sponsorship`.

**Deduplication preserves provenance.** One canonical posting per
`canonical_hash`; every source capture retained as an immutable `job_snapshot`.
The Job Folder's promise — *this is exactly what the posting said when you
applied* — depends on snapshot immutability.

## Eligibility engine (Stage 07) — distinct from scoring
Deterministic, explainable, jurisdiction-aware pass/fail gates: work
authorisation, sponsorship, licensure/certification, location and radius,
security clearance, language.

Output is a structured `eligibility_results` record with a per-rule reason,
**never a number**. A candidate must never be shown a 92% match for a role they
are legally ineligible for.

## Compatibility engine (Stage 08)
The mandated pipeline, replacing any notion of `resume + JD → LLM → %`:

```
job parsing → hard eligibility → requirement extraction →
candidate evidence retrieval → deterministic comparison →
semantic comparison (pgvector) → weighted scoring → transparent explanation
```

- The **existing deterministic engine becomes the deterministic stage** — it is
  preserved, not replaced.
- Weights are admin-configurable, versioned data; every score records the weight
  version used, so historical scores remain explicable after a weight change.
- `match_dimensions` persists each dimension's contribution.
- The candidate sees: compatibility, eligibility, strengths, gaps, transferable
  evidence, risks, and the reason for the recommendation.

## Explicitly not modelled yet
**Interview probability.** Kept separate from compatibility and not claimed until
enough real outcome data exists to calibrate it. Publishing an uncalibrated
probability would be a false precision the product cannot support.
