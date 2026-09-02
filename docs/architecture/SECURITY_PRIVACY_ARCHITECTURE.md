# Security & Privacy Architecture

Every claim below is marked with measured status. **Nothing is claimed secure
because a framework defaults to it.**

## Verified strengths (read at `35d3491`)

| Control | Implementation | Status |
| --- | --- | --- |
| Password storage | bcrypt cost 10 | PASS |
| Production secret hygiene | `AUTH_SECRET` rejected **by value** when it equals the `.env.example` placeholder; throws in production | PASS |
| Secret separation | `PAYLOAD_SECRET` distinct from `AUTH_SECRET` | PASS |
| Staff gate | Allowlist **and** role, fails closed, no wildcards, unknown role → least privilege | PASS |
| API keys | SHA-256 of the whole key, `timingSafeEqual`, prefix design, never re-displayed | PASS |
| Path traversal | `basename` + `resolve` + prefix containment | PASS |
| Webhook authenticity | Stripe signature verified; 500 triggers retry | PASS |
| Outbound SSRF | Loopback/RFC1918/link-local/ULA blocked; `redirect: 'error'` prevents signed-payload relay | PARTIAL — DNS rebinding documented in-source |
| Prompt interpolation | Single-pass, non-recursive; missing variable is a hard error | PASS |
| Rate limiting | Per-actor buckets on scan/apply/interview-prep/auth | PARTIAL — in-process only |

## Verified weaknesses (remediation stage in brackets)

| # | Finding | Sev | Stage |
| --- | --- | --- | --- |
| S-01 | No RLS; isolation is 63 hand-written filters with no backstop or test | HIGH | 01 |
| S-02 | No `middleware.ts`; no global auth gate — a new route is public by default | HIGH | 01 |
| S-03 | Stripe webhook not idempotent; `WebhookEvent` exists unused | HIGH | 01 |
| S-04 | Sessions unrevocable — stateless 30-day JWT; logout deletes the cookie only | HIGH | 01 |
| S-05 | CSRF defence is `sameSite: lax` alone | MED | 01 |
| S-06 | Unsanitised input in `Content-Disposition` filename | MED | 01 |
| S-07 | No MFA, email verification, recovery, device list or OAuth | HIGH | 01 |
| S-08 | Rate limits per-instance; ceiling multiplies with instances | MED | 01 |
| S-09 | No sensitive-demographic architecture (no fields yet — a design gap) | HIGH | 02 |

## Not yet assessed — must not be claimed

File-upload malware scanning · encryption at rest for documents · backup
integrity and **restore rehearsal** · disaster recovery (no RPO/RTO defined) ·
penetration testing · accessibility · dependency provenance/SBOM · log redaction
of PII · AI output leakage across tenants · third-party processor agreements.

Each is a Stage 23 deliverable and is `NOT VERIFIED` until it has evidence.

## Privacy architecture

- **Data classification** (`../governance/DATA_CLASSIFICATION.md`) drives access,
  logging, retention and residency. `RESTRICTED` covers case notes, mailbox
  content and sensitive demographics.
- **Sensitive-attribute isolation** (`ADR-0007`): separate schema, separate
  grants; matching, scoring, ranking and AI paths hold **no privileges** on it,
  so inclusion is a runtime permission error rather than a silent leak.
- **Consent** is explicit, granular, versioned, revocable, and emits
  `CONSENT_CHANGED`. Revocation purges derived content (notably Stage 11 mailbox
  data).
- **Retention** is policy-driven per data category and configurable per
  organisation — public-sector tenants have their own obligations.
- **Erasure** preserves the existing scrub-in-place pattern so financial and
  audit records survive erasure of personal data.
- **Residency**: Canada by default, with each cross-border processor recorded as
  a documented exception (`ADR-0015`).

## AI-specific security
- **Prompt injection**: interpolation is single-pass and non-recursive
  (implemented). Job descriptions and emails are **untrusted input** and must
  never be able to redirect a system prompt.
- **Data leakage**: evidence references, not whole profiles. Never sensitive
  attributes. Never mailbox content without explicit consent. Never another
  tenant's data in a shared context.
- **Traceability**: every material AI action writes an `ai_runs` record
  (`ADR-0006`).
- **Truthfulness**: enforced structurally by evidence grounding, and tested
  (`../governance/AI_GOVERNANCE.md`).
