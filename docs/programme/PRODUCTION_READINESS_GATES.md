# Production Readiness Gates

Every gate needs **evidence**, not an assertion. Status: `PASS` · `PARTIAL` ·
`FAIL` · `NOT VERIFIED` · `BLOCKED` (the reason is external: a credential, a
legal decision, an environment this programme cannot reach).

**Overall: NOT READY FOR PRODUCTION.** Re-measured row by row in Stage 23
(2026-09-05, ADR-0037) against the stacked head of Stages 00-23. "Current"
names the evidence; a stage number in brackets is where it was proven. The
Stage 00 baseline this table replaced is in git history.

## G1 — Build and quality

| Gate | Required | Current | Status |
| --- | --- | --- | --- |
| Install from lockfile | exit 0 | exit 0 (`npm ci`, retried once for ETXTBSY, R-32) | PASS |
| Typecheck | exit 0 | exit 0 | PASS |
| Unit + integration tests | all pass | 1302 / 1302 with `CI=true` against migrated PostgreSQL; database suites THROW when the URLs are unset in CI | PASS |
| Production build | exit 0 | exit 0, 102 routes | PASS |
| Lint | configured, non-interactive, clean | flat config, `eslint` directly; 0 errors, 8 warnings locked by `--max-warnings=8` (`LINT_BASELINE.md`) | PASS |
| CI enforcing all of the above | required on `main` | `ci.yml` verify · mobile · generated-files · line-endings · accessibility · sbom, all green on the stacked branches; **branch protection is an EXTERNAL ACTION** (`AUTONOMOUS_STATUS.json`) | PARTIAL |
| E2E on critical journeys | present | the accessibility suite drives 42 rendered pages signed in (Stage 23); the contract suite validates every `/api/v1` response (Stage 14); no browser journey through apply → submit exists | PARTIAL |

## G2 — Security

| Gate | Required | Current | Status |
| --- | --- | --- | --- |
| No high/critical advisories in deployed deps | 0 | 3 high remain, all in the dev-only Prisma chain (ADR-0017); `dependency-review.yml` gates PRs; SBOM produced per run (Stage 23) | PARTIAL |
| Global authentication gate | middleware, deny by default | `src/proxy.ts` denies by default; the public list is enumerated and negative-tested (Stage 01) | PASS |
| Tenant isolation | RLS + filters + tests | every table `ENABLE`+`FORCE` RLS with generated policies; filters kept; the mechanism proof and the tenancy suite run in CI against PostgreSQL (Stage 01, R-33) | PASS |
| Tenant isolation proven on the **deployed pooled runtime** | proven | proven against a pool capped at one connection locally; the managed pooler is **unreachable from this environment** | BLOCKED (environment) |
| Session revocation | immediate | sessions are rows; refused on revoke, expiry, password epoch, per request, no cache (Stage 01) | PASS |
| MFA | available; required for staff | absent; step-up re-authentication on every staff write (Stage 20); OIDC SSO for organisations (Stage 20) | PARTIAL |
| Webhook idempotency | enforced | `WebhookEvent` replay and ordering (Stage 01, 15) | PASS |
| Secret management | managed store; no placeholders in prod | placeholder rejected by value; no secret-shaped string tracked (static test, Stage 23); a managed store is Stage 24 | PARTIAL |
| Password storage | modern hashing | bcrypt cost 10 | PASS |
| API key storage | hashed, constant-time compare | SHA-256 + `timingSafeEqual`; device keys capped and revoked with sessions (Stage 14) | PASS |
| Path traversal | defended | basename + resolve + containment; signed ten-minute links (Stage 09) | PASS |
| SSRF on outbound | defended | blocked ranges + no redirects; DNS-rebinding gap documented (R-24) | PARTIAL |
| CSRF | tokens on state-changing routes | `sameSite: lax` AND an explicit cross-site refusal on every write carrying the session or the CMS cookie (`Sec-Fetch-Site` same-origin only; `Origin` against `Host`, Stage 23); no token, stated | PASS |
| Response headers | CSP, HSTS, framing, sniffing | one header list on every route; CSP without `script-src` (nonce policy is Stage 24, ADR-0037); HSTS `includeSubDomains` requires TLS on every subdomain, stated | PARTIAL |
| Penetration test | independent, remediated | none; four independent adversarial code reviews (Stages 19-21) are not one; **EXTERNAL ACTION** | NOT VERIFIED |
| Upload malware scanning | present | structural scan only (`scan.ts`); **no antivirus engine, never claimed** | PARTIAL |
| Log PII redaction | enforced | every server-side error log goes through `redactError`, enforced by a static scan of every `console.error`/`warn` under `src` (review M2); client components excluded | PASS |
| Rate limiting | shared store | in-process, per instance (R-16); correct for a single instance | PARTIAL |
| Impersonation | read-only, time-boxed, audited | `route()` refuses every write; 60 minutes; reason; both cookies bound; sensitive reads refused (Stage 20) | PASS |

## G3 — Data

| Gate | Required | Current | Status |
| --- | --- | --- | --- |
| Production-grade database | PostgreSQL managed | PostgreSQL 16, Prisma; managed project provisioned but **unreachable from this environment** | PARTIAL |
| Versioned migrations | present, reviewed, reproducible history | 56 migrations; CI applies to an empty database and fails on drift (Stage 01) | PASS |
| Migration recovery | restore point per migration; recovery plan; staging rehearsal | procedure and recovery in `DATABASE_MIGRATIONS.md`; backup before deploy scripted (Stage 23); **staging rehearsal NOT VERIFIED (R-34)** | PARTIAL |
| Backups | automated + PITR | `db:backup` logical dump with checksum (Stage 23); provider PITR NOT VERIFIED; no schedule yet | PARTIAL |
| **Restore rehearsal** | performed and documented | performed twice on local PostgreSQL 16, log in `BACKUP_RESTORE.md`; the second run (after review H2: the first dump dropped the grants and the restored database served nothing to the tenant path) keeps privileges, grants role membership and proves the tenant and sensitive paths, then passes the tenancy suite against the restored copy; not at production size | PASS (local) |
| Data classification | applied per table | every table classified in `rls-tables.ts` (coverage test) and in `DATA_CLASSIFICATION.md`; the RESTRICTED schema has no Prisma model (ADR-0007) | PASS |
| Retention enforcement | automated | `retention:sweep` for every platform-default row; three contract rows NOT AUTOMATED, stated in the matrix (Stage 23) | PARTIAL |
| Erasure | working, statutory-safe | scheduled scrub-in-place erasure across the person's tables (the review found six the first version missed, now covered and tested); blockers re-checked at execution; NOT reached: the payment provider's own customer record, stated in the UI | PASS |
| Residency | Canada for personal data | not deployed; the S3 provider refuses a region outside the allow-list (ADR-0015) | NOT VERIFIED |
| **Per-tenant AI processing policy** enforced in the gateway, failing closed | enforced | `EXTERNAL_AI_PROHIBITED` when missing; RESTRICTED keys refused; static test (Stage 03) | PASS |

## G4 — Reliability

| Gate | Required | Current | Status |
| --- | --- | --- | --- |
| Background processing | queue + workers + DLQ | **none**; every sweep is an operator command; freshness lines say when one has not run | FAIL |
| Rate limiting | shared store | in-process (R-16) | PARTIAL |
| Caching | shared, invalidating | abstraction with memory and Redis backends; Redis optional | PARTIAL |
| Durable artefact storage | object storage | S3-compatible provider with residency check, local by default; never run against a real bucket | PARTIAL |
| Health checks | app, DB, cache, queue, connectors | `/api/health`: database, migrations, cache, storage, job sources, marts (Stage 23); fixed words only, memoised, budgeted per address AND per instance (review M3); no queue exists | PARTIAL |
| Monitoring & alerting | present with on-call | none; the health check is what a monitor would poll | FAIL |
| SLOs | defined | none (Stage 24) | FAIL |
| DR plan with RPO/RTO | documented + rehearsed | `DISASTER_RECOVERY.md`: proposed objectives, six scenarios; rehearsed locally (scenario 2); provider PITR and rollback NOT REHEARSED | PARTIAL |
| Rollback | rehearsed | forward-only migrations with a written recovery; not rehearsed | FAIL |
| Incident response | runbook | `INCIDENT_RESPONSE.md` (Stage 23); never exercised; no on-call | PARTIAL |

## G5 — Product integrity

| Gate | Required | Current | Status |
| --- | --- | --- | --- |
| **No UI promises unimplemented behaviour** | verified | auto-apply disabled and labelled; every mart page shows freshness; Stage 22 gate recorded | PASS |
| AI truthfulness enforced | evidence grounding + tests | every generated section grounded in code against résumé and approved evidence; `AiRun` per call (Stage 03) | PASS |
| Eligibility gates recommendations | enforced | evaluated before fit; ineligible never a match; `unknown` never excludes (Stage 07) | PASS |
| Score explainability | dimensions + evidence | one `MatchDimension` per dimension with cited evidence ids (Stage 08) | PASS |
| Sensitive attributes excluded from decisions | structurally | the `sensitive` schema, its own role and module; static allow-list tests (Stages 02, 07, 08, 17, 18, 23) | PASS |
| Consent model | granular, revocable, audited | `ConsentRecord` per purpose and version; case, disclosure and representation consents; draft wording refused in production (L-5) | PASS (engineering) / BLOCKED (wording, L-5) |
| Integration status accuracy | no overstatement | `INTEGRATION_REGISTER.md`: every external integration IMPLEMENTED-NOT-VALIDATED | PASS |
| Accessibility WCAG 2.2 AA | tested | 42 rendered pages pass axe A/AA (light theme) in CI (Stage 23); dark theme and interactions not measured | PASS (axe, light) |
| Performance budgets | defined and measured | budgets per route and per batch job; measured locally within budget (Stage 23); production NOT measured | PARTIAL |

## G6 — Commercial

| Gate | Required | Current | Status |
| --- | --- | --- | --- |
| Payment provider validated | live or full sandbox E2E | never run; no key in this environment (Stage 15) | BLOCKED (credential) |
| Entitlement separated from payment | enforced | `Entitlement` rows are the only thing feature code reads; static test (Stage 15) | PASS |
| Invoicing | correct, tested | extensive, tested; placement invoicing in its own book (Stage 19) | PASS |
| Tax | determination + registration policy | implemented, unvalidated | PARTIAL |
| No card data stored | verified | verified — the gateway holds it | PASS |

## G7 — Operability

| Gate | Required | Current | Status |
| --- | --- | --- | --- |
| Founder can run routine business changes | no deploy needed | organisations, users, roles, flags, sources, taxonomy, prompts, weights, mappings, entitlements, staffing rules, audit export in `/console` (Stages 03-20); plans/prices, templates, retention beyond cases still need a deploy | PARTIAL |
| Platform admin | users, orgs, plans, sources, AI, flags | present except plans/prices (Stage 20) | PARTIAL |
| Impersonation read-only, audited | enforced | enforced in `route()`, tested (Stage 20) | PASS |
| Runtime config under governed admin with versioning, approval and rollback | governed | `PromptVersion`, `AtsRuleset`, `FieldMappingVersion`, `MatchWeightVersion` governed with versions and approval | PASS |
| Audit coverage | every privileged action | every staff write, consent, sensitive read, sign-in outcome, erasure, retention sweep, export. **NOT hash-chained**: the `prevHash`/`hash` columns exist and no code writes them (corrected in the Stage 23 review; Stage 24+) | PASS (coverage) / NOT IMPLEMENTED (chain) |
| Runbooks & on-call | present | migrations, backup/restore, DR and incident runbooks (Stage 23); **no on-call** | PARTIAL |
| Reporting reads marts only | enforced | static tests on every reporting surface (Stages 13, 21) | PASS |

## Minimum bar for a first production release

G1 all PASS · G2 no FAIL · G3 database, migrations, backups **and a rehearsed
restore** PASS · G4 background processing and durable storage PASS · G5 all
PASS · G6 payment validated · G7 admin sufficient for routine operation.

**Where it stands after Stage 23:** G1 two PARTIAL (branch protection,
browser journeys); G2 no FAIL, six PARTIAL and one NOT VERIFIED (the
penetration test); G3 backups PARTIAL until the provider's PITR is
exercised; G4 background processing, monitoring, SLOs and rollback FAIL —
Stage 24 items; G5 consent wording BLOCKED on counsel; G6 payment BLOCKED on
a credential; G7 PARTIAL. The bar is not met, and the reasons are named.
