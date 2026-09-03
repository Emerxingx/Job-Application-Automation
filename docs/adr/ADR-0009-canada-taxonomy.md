# ADR-0009 — Canadian labour-market taxonomy, US-compatible

**Status:** Proposed · **Date:** 2026-09-02 · **Implemented (Stage 04, 2026-09-03):** canonical `Occupation` with `OccupationCode` per scheme/version (NOC 2021 with explicit TEER; SOC 2018), translatable `OccupationLabel` / `SkillLabel` / `RegionLabel` records, `OccupationSkill`, `SkillMapping`, `CareerPath`, a `Region` tree for CA and US, and the licence gate (`TaxonomyDataset` + `requireIngestible`). The Adzuna regex table is now `src/lib/taxonomy/fallback.ts`, recorded as `regex_fallback` on `Job.occupationSource`. No real dataset is ingested (L-2). Evidence: `../programme/STAGE04_EVIDENCE.md`.

## Context
Canada is a first-class market. Measured: the entire current occupational
implementation is a **9-entry regex table** mapping job titles to NOC codes,
embedded in the Adzuna adapter. There is no occupation table, no skills taxonomy,
no TEER, no economic regions, and no bilingual content model.

The US must coexist (SOC, state/city, USD, US work authorisation) without
collapsing Canadian semantics into American ones.

## Decision
Build a **jurisdiction-aware occupational spine**, Canada first.

- `occupations` carries a canonical internal id plus jurisdiction-specific codes:
  NOC + TEER for Canada, SOC for the US. Neither is the primary key — the
  canonical id is, so a third jurisdiction is additive.
- `skills_taxonomy` and `occupation_skills` model skills and competencies
  independently of any single national scheme, mapped to the Canadian Skills and
  Competencies Taxonomy and to O*NET-derived structures **only where licensing
  permits**.
- Geography: country → province/territory (or state) → economic region → city →
  postal region, so Canadian economic regions and US metro areas both fit.
- Compensation carries an explicit currency and period. CAD is not assumed.
- **Bilingual EN/FR from the schema outward**, not retrofitted: occupation and
  skill labels are translatable records, not columns.

**Licensing is a precondition, not a follow-up.** NOC, TEER, OaSIS, the Canadian
Skills and Competencies Taxonomy and O*NET each have distinct terms. No dataset
is ingested before its licence and attribution obligations are recorded in
`SOURCE_ACCESS_POLICY.md`.

## Consequences
- The Adzuna regex table is superseded by real classification but retained as a
  low-confidence fallback, with confidence recorded rather than implied.
- Matching, eligibility, career transition and learning all key off the canonical
  occupation id, so adding the US requires no engine change.
- Bilingual support has a cost in every content surface. Accepted deliberately:
  retrofitting French into a monolingual schema later is far more expensive, and
  federal and BC public-sector buyers will require it.

## Revisit when
NOC is revised (it is periodically restructured — version the taxonomy and keep
crosswalks), or a third jurisdiction is added.
