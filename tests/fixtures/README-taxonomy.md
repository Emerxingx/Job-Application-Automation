Hand-written test fixtures in the shape of the Statistics Canada NOC 2021
structure file (Level, Hierarchical structure, Code, Class title, Class
definition) with an example-titles column, in English and French, plus a
NOC ↔ SOC crosswalk sample in `tests/taxonomy.test.ts`.

They are a dozen nodes authored for tests, attributed to Statistics Canada
(NOC 2021 Version 1.0) and the U.S. Bureau of Labor Statistics (SOC 2018),
whose classification structures they follow. They are not the datasets, are
never loaded outside a test database, and do not pre-empt the licence review
recorded in `docs/governance/SOURCE_ACCESS_POLICY.md` (L-2).
