Hand-written test fixtures in the shape of the Statistics Canada NOC 2021
downloads, with the published column headers copied verbatim:

- `noc-2021-sample.csv` (EN, with a UTF-8 byte-order mark as the download
  carries) and `noc-2021-sample.fr.csv` (FR headers) — the STRUCTURE file
  shape: Level · Hierarchical structure · Code - NOC 2021 V1.0 · Class title
  · Class definition. Nineteen nodes across two broad categories (every node has its parent, as the loader requires).
- `noc-2021-elements-sample.csv` / `.fr.csv` — the ELEMENTS file shape:
  Level · Hierarchical structure · Code · Class title · Element type ·
  Element description. Illustrative examples are the alternate titles.
- A NOC ↔ SOC crosswalk sample lives in `tests/taxonomy.test.ts`.

They are nineteen nodes authored for tests, attributed to Statistics Canada
(NOC 2021 Version 1.0) and the U.S. Bureau of Labor Statistics (SOC 2018),
whose classification structures they follow, and they reproduce a handful of
real unit-group codes and titles — the same handful the legacy regex table
in `src/lib/taxonomy/fallback.ts` has carried since Stage 00. They are not
the datasets, are never loaded outside a test database, and do not pre-empt
the licence review recorded in `docs/governance/SOURCE_ACCESS_POLICY.md`
(L-2); if that review rules the titles out, the fixture is rewritten with
invented ones and the regex table goes with it.

The real files have not been loaded: the parsers are written against the
published header names and row structure, and that is all the fixture proves.
