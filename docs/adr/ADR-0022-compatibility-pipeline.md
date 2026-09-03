# ADR-0022 — Compatibility is a decomposable, versioned pipeline, never résumé + JD → model → %

**Status:** Accepted (Stage 08, 2026-09-03) · **Implements:** `JOB_INTELLIGENCE_ARCHITECTURE.md` "Compatibility engine (Stage 08)" · **Preserves:** the Stage 00 deterministic engine

## Context

The deterministic keyword/semantic engine already produced a score breakdown,
matched and missing keywords and a rationale — explainable and stable. What
it lacked was the mandated pipeline around it: eligibility first (Stage 07),
requirement extraction from the canonical job (Stage 06), evidence retrieval
(Stage 03), a semantic stage, weights as governed data, and per-dimension
persistence so a score stays explicable after the weights change.

## Decision

1. **The deterministic engine is the deterministic stage.** It is preserved;
   the pipeline injects its weights and an equivalence map and reads its
   breakdown. No stage replaces it with a model call.
2. **Weights are governed, versioned data.** `MatchWeightVersion` follows the
   prompt LIFECYCLE and separation of duties: draft → approved by a second
   admin → active (one at a time; an older activation is a recorded
   rollback) → retired, each step re-authenticated and audited. It does NOT
   yet have the prompt registry's evaluation gate — there is no scored
   corpus to evaluate a weight change against — so activation requires a
   mandatory, audited reason in its place. Nothing is seeded active: until
   an admin activates a version the built-in constants apply and are
   recorded as `builtin:1`. The recorded score is always the governed
   weights applied to the grounded breakdown (`combineScore`), on every
   route, so `weightVersion` describes the score whichever engine served.
3. **Every score records its versions.** `JobMatch.weightVersion` and
   `pipelineVersion` are written at scoring time and never rewritten; a
   weight change affects new scores only.
4. **Every score is decomposable.** One `MatchDimension` row per named
   dimension carries its score, weight, contribution, matched and missing
   items and the approved `CareerEvidence` ids cited for it. The page shows
   them.
5. **The semantic stage is honest about what it is.** pgvector is BLOCKED
   (the extension is not available locally or in CI and staging is
   unreachable), so no embedding is computed or pretended. The stage is a
   closed equivalence map over the skill vocabulary applied to BOTH sides
   (the posting's spellings are deduplicated under it); a match made through
   it is persisted on the skills dimension as `{ term, how: 'semantic', via }`
   and shown to the candidate as such. An embedding comparer can replace it
   behind the same function when the extension exists.
7. **Requirement extraction is consumed, not decorative.** The canonical
   job's `requiredSkills`, `preferredSkills`, `certificationRequirements`
   and `experienceYearsMin` reach the engine: a missing nice-to-have costs
   half a requirement and is marked `preferred`; a required credential
   counts in full; the extracted minimum years replaces the regex. Education
   requirements are NOT scored (the engine has no education dimension) and
   the evidence says so rather than pretending.
8. **A citation is a claim that supports the term.** A vocabulary term is
   found in a claim the way the engine finds it (boundary-aware pattern under
   the map), an ambiguous word ("go", "r", "rest", "excel"…) needs a skill
   claim or a proper-noun spelling, and a keyword token must appear whole.
   The keyword-density dimension decomposes into the tokens it counted, not
   into the skills list.
6. **Sensitive attributes are structurally absent.** The pipeline's inputs
   are the résumé projection, approved evidence and the canonical job; the
   ADR-0007 allowlist test covers the new modules.

## Consequences

- The five dimensions and their weights are visible to the candidate on
  every match, with the evidence behind them; the console shows which
  version scores today.
- Changing a weight is a governed operation with a second approver, not a
  code edit; the old scores keep their meaning.
- The semantic stage's recall is bounded by the equivalence map; the map is
  data and is reviewed like any other change.
