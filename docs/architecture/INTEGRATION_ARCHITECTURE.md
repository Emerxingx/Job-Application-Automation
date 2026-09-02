# Integration Architecture

**Register:** `../governance/INTEGRATION_REGISTER.md` · **Source policy:** `../governance/SOURCE_ACCESS_POLICY.md`

## The pattern that already works — extend it
Every integration follows the established provider shape, which is one of the
strongest ideas in the codebase:

1. An interface in `src/lib/providers/<domain>/types.ts`.
2. A **mock implementation that is the default** — the product runs fully with no
   third-party credentials.
3. Real adapters **lazily `require`d**, so an SDK never loads in a deployment
   that does not use it.
4. Selection by environment variable, with **warn-and-degrade**: a configured
   provider missing its credential logs a warning and falls back rather than
   crashing.

This is why a clean clone boots with zero configuration, and it is why the
repository has never misrepresented a mock as production.

## Classification discipline
Every integration carries an explicit status; **code existing is not evidence of
working**:

`PRODUCTION-VALIDATED` · `SANDBOX-VALIDATED` · `IMPLEMENTED-NOT-VALIDATED` ·
`MOCK` · `STUB` · `CONFIG-ONLY` · `PLANNED` · `DEAD`

Current classifications are in `CURRENT_BASELINE.md` §7. **No integration is
currently `PRODUCTION-VALIDATED`.**

## Inbound integrations
Job sources via the connector contract (`ADR-0008`); taxonomy datasets
(licence-gated, `ADR-0009`); email and calendar (Stage 11, least-privilege
incremental OAuth scopes); identity providers (`ADR-0004`).

## Outbound integrations
AI providers via the gateway (`ADR-0006`) — never imported directly by product
code. Payment gateways via the existing abstraction. Customer webhooks via the
existing delivery state machine.

## Public API
`/api/v1` is the third-party surface and uses a **structured error envelope**
(`{ error: { type, code, message, param } }`) distinct from the internal
`{ error: string }`. This distinction is deliberate — a third-party client cannot
branch on English prose — and is preserved. It becomes the mobile contract
(`ADR-0013`).

API keys: SHA-256 of the whole key, `timingSafeEqual`, prefix design, never
re-displayed. **No CORS headers**, deliberately: an API key is a bearer credential
and must never be shipped to a browser.

## Webhook delivery (implemented; needs a worker)
A full state machine — `pending`, `succeeded`, `failed`, `exhausted`, `skipped` —
with retry scheduling and an index built for a worker's single query. **No worker
runs it** (`ADR-0011`).

SSRF controls: protocol restriction, HTTPS required in production, loopback and
RFC1918/link-local/ULA blocked, and `redirect: 'error'` so a signed payload is
never re-POSTed to an unregistered host. The residual DNS-rebinding gap is stated
honestly in-source and remains open.

## Inbound webhook idempotency — currently missing
The `WebhookEvent` model exists for de-duplication and is **unreferenced**. The
Stripe handler will re-run `activatePlan` on a replayed event. Fixed in Stage 01;
a precondition of `ADR-0010`.

## Integration health
Every integration reports health, error rate, latency and last success to an
admin surface (`ADR-0019`). An integration that fails silently is worse than one
that is absent.
