# ADR-0011 — Events and background processing

**Status:** Proposed · **Date:** 2026-09-02

## Context
There is **no background processing at all**: no queue, no worker, no scheduler.

Two designs in the codebase anticipate one and are stranded:
- `AgentSchedule` has `nextRunAt`, `lockedAt`, `lockedBy`, `consecutiveFailures`,
  `autoAppliedCount` — a complete lease-based scheduler. **Nothing reads it.**
- Outbound webhooks have a full delivery state machine (`pending`, `succeeded`,
  `failed`, `exhausted`, `skipped`) with retry scheduling and an index designed
  for a worker's single query. **No worker runs it.**

This blocks job ingestion, normalisation, dedup, AI scoring at volume, document
generation, email sync, PDF export, reporting rollups and notifications.

## Options
- **A. In-process on the request path.** Already the constraint; caps everything
  at HTTP timeout.
- **B. Postgres-backed queue with lease semantics** (SKIP LOCKED).
- **C. Managed queue** (SQS, Cloud Tasks) or a Redis-backed runner (BullMQ).

## Decision
**Option B first, with the interface designed for C.**

The database is already the transaction boundary. A Postgres-backed queue gives
exactly-once-ish semantics with the enqueue in the *same transaction* as the state
change that caused it — an **outbox**, which avoids the classic "committed the row,
lost the job" failure. `AgentSchedule` and `WebhookDelivery` already model this;
they get their worker rather than a redesign.

**Platform events** (published to an `outbound_events` outbox, consumed
asynchronously): `USER_CREATED`, `JOB_DISCOVERED`, `JOB_NORMALIZED`,
`JOB_MATCHED`, `JOB_CLOSED`, `APPLICATION_CREATED`, `DOCUMENT_GENERATED`,
`APPLICATION_SUBMITTED`, `EMAIL_RECEIVED`, `INTERVIEW_DETECTED`,
`OFFER_RECEIVED`, `CLIENT_ASSIGNED`, `ACTION_PLAN_CREATED`,
`INTERVENTION_RECORDED`, `CAREER_PATH_CREATED`, `LEARNING_PLAN_CREATED`,
`SUBSCRIPTION_CREATED`, `PAYMENT_SUCCEEDED`, `CONSENT_CHANGED`.

## Consequences
- Workers run as a separate process against the same codebase — the modular
  monolith stays one deployable artifact with two entry points.
- Workers bypass RLS and therefore run under a narrow, audited role (`ADR-0005`).
- Every handler must be **idempotent**; every job carries a stable key.
- Failure handling is explicit: bounded retries with backoff, a dead-letter state,
  and admin visibility (`ADR-0019`). Silent job loss is the failure mode that
  destroys trust in an automation product.
- The event stream is also the input to reporting (`ADR-0012`) and the extraction
  seam for `ADR-0001`.

## Revisit when
Queue depth or fan-out makes Postgres the bottleneck — move to Option C behind
the same interface.
