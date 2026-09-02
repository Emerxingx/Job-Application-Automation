# Production Readiness Gates

Every gate needs **evidence**, not an assertion. Status: `PASS` · `PARTIAL` ·
`FAIL` · `NOT VERIFIED`.

**Overall: NOT READY FOR PRODUCTION.**

## G1 — Build and quality

| Gate | Required | Current | Status |
| --- | --- | --- | --- |
| Install from lockfile | exit 0 | exit 0 | PASS |
| Typecheck | exit 0 | exit 0 | PASS |
| Unit + integration tests | all pass | 670/670 | PASS |
| Production build | exit 0 | exit 0, ~79 routes | PASS |
| Lint | configured, non-interactive, clean | **not installed; prompts; exit 1** | **FAIL** |
| CI enforcing all of the above | required on `main` | **absent** | **FAIL** |
| E2E on critical journeys | present | absent | FAIL |

## G2 — Security

| Gate | Required | Current | Status |
| --- | --- | --- | --- |
| No high/critical advisories in deployed deps | 0 | **6 high** | **FAIL** |
| Global authentication gate | middleware, deny by default | absent | **FAIL** |
| Tenant isolation | RLS + filters + tests | filters only, untested | **FAIL** |
| Session revocation | immediate | 30-day stateless JWT | **FAIL** |
| MFA | available; required for staff | absent | FAIL |
| Webhook idempotency | enforced | absent | **FAIL** |
| Secret management | managed store; no placeholders in prod | placeholder rejected by value | PARTIAL |
| Password storage | modern hashing | bcrypt cost 10 | PASS |
| API key storage | hashed, constant-time compare | SHA-256 + `timingSafeEqual` | PASS |
| Path traversal | defended | basename + resolve + containment | PASS |
| SSRF on outbound | defended | blocked ranges + no redirects; DNS-rebinding gap | PARTIAL |
| CSRF | tokens on state-changing routes | `sameSite: lax` only | PARTIAL |
| Penetration test | independent, remediated | none | **NOT VERIFIED** |
| Upload malware scanning | present | none | NOT VERIFIED |
| Log PII redaction | enforced | unverified | NOT VERIFIED |

## G3 — Data

| Gate | Required | Current | Status |
| --- | --- | --- | --- |
| Production-grade database | PostgreSQL managed | **SQLite** | **FAIL** |
| Versioned migrations | present, reversible | **none** | **FAIL** |
| Backups | automated + PITR | none | **FAIL** |
| **Restore rehearsal** | performed and documented | none | **FAIL** |
| Data classification | applied per table | defined, not applied | PARTIAL |
| Retention enforcement | automated | none | FAIL |
| Erasure | working, statutory-safe | scrub-in-place designed; `DeletionRequest` unused | PARTIAL |
| Residency | Canada for personal data | not deployed | NOT VERIFIED |

## G4 — Reliability

| Gate | Required | Current | Status |
| --- | --- | --- | --- |
| Background processing | queue + workers + DLQ | **none** | **FAIL** |
| Rate limiting | shared store | in-process | PARTIAL |
| Caching | shared, invalidating | abstraction exists; Redis optional | PARTIAL |
| Durable artefact storage | object storage | local filesystem | **FAIL** |
| Health checks | app, DB, cache, queue, connectors | none | FAIL |
| Monitoring & alerting | present with on-call | none | FAIL |
| SLOs | defined | none | FAIL |
| DR plan with RPO/RTO | documented + rehearsed | none | FAIL |
| Rollback | rehearsed | none | FAIL |

## G5 — Product integrity

| Gate | Required | Current | Status |
| --- | --- | --- | --- |
| **No UI promises unimplemented behaviour** | verified | **auto-apply toggle does nothing** | **FAIL** |
| AI truthfulness enforced | evidence grounding + tests | none | **FAIL** |
| Eligibility gates recommendations | enforced | absent | FAIL |
| Score explainability | dimensions + evidence | dimensions yes, evidence no | PARTIAL |
| Sensitive attributes excluded from decisions | structurally | no architecture yet | FAIL |
| Consent model | granular, revocable, audited | absent | FAIL |
| Integration status accuracy | no overstatement | **accurate — a positive finding** | PASS |

## G6 — Commercial

| Gate | Required | Current | Status |
| --- | --- | --- | --- |
| Payment provider validated | live or full sandbox E2E | never run | **FAIL** |
| Entitlement separated from payment | enforced | fused | FAIL |
| Invoicing | correct, tested | extensive, tested | PASS |
| Tax | determination + registration policy | implemented, unvalidated | PARTIAL |
| No card data stored | verified | verified — Stripe holds it | PASS |

## G7 — Operability

| Gate | Required | Current | Status |
| --- | --- | --- | --- |
| Founder can run routine business changes | no deploy needed | CMS + console only | PARTIAL |
| Platform admin | users, orgs, plans, sources, AI, flags | absent | FAIL |
| Impersonation read-only, audited | enforced | model exists, unused | FAIL |
| Audit coverage | every privileged action | partial | PARTIAL |
| Runbooks & on-call | present | none | FAIL |
| Accessibility WCAG 2.2 AA | tested | untested | NOT VERIFIED |

## Minimum bar for a first production release
G1 all PASS · G2 no FAIL · G3 database, migrations, backups **and a rehearsed
restore** PASS · G4 background processing and durable storage PASS · G5 all PASS ·
G6 payment validated · G7 admin sufficient for routine operation.
