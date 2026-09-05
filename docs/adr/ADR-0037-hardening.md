# ADR-0037 — Hardening: response headers, an explicit CSRF check, a health check, log redaction, account erasure and retention as code, accessibility and performance as measurements, backup and recovery as rehearsed procedure

**Status:** Accepted (Stage 23, 2026-09-05) · **Implements:** `MASTER_BUILD_PLAN.md` Stage 23; readiness gates G2, G3, G4 re-measured · **Depends on:** ADR-0004 (sessions), ADR-0005 (RLS), ADR-0007 (the sensitive schema and its single module), ADR-0015 (residency), ADR-0023 (document versions and the erasure cascade), ADR-0025 (mailbox revocation), ADR-0036 (the marts the retention sweep thins) · **External:** a third-party penetration test is an action the founder commissions; nothing here is one

## Context

Every earlier stage built a control and tested it. What remained were the
readiness-gate rows that say **NOT VERIFIED** or **FAIL** because no
evidence existed either way: log redaction, CSRF beyond a cookie attribute,
a health check, backups and a restore, disaster recovery, incident
response, retention enforcement, account erasure (designed in Stage 00,
modelled as `DeletionRequest`, never built), accessibility (never
measured), performance (never measured), dependency provenance. Stage 23's
job is to turn each of those into a measurement or a rehearsal, and to say
plainly which ones still cannot be measured from this environment.

## Decision

1. **Response headers are one list.** `security-headers.mjs` at the
   repository root is imported by `next.config.mjs` (every route, the
   Payload admin and the API included) and by the static test, so the
   header set that ships is the one the test reads. `Content-Security-Policy`
   carries `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`
   and `form-action 'self'` — the directives that protect without a nonce —
   and deliberately NO `script-src`: Next's inline bootstrap and Payload's
   admin bundle need a per-request nonce policy, which is Stage 24 work with
   the CDN in front; a script policy the application violates is worse than
   none. HSTS, `nosniff`, `Referrer-Policy`, `Permissions-Policy`,
   `X-Frame-Options`, COOP and DNS-prefetch off complete the list.

2. **CSRF is refused explicitly, not only by `sameSite`.** The edge gate
   (`src/proxy.ts`, `isCrossSiteWrite`) refuses a state-changing request
   that carries the session cookie when the browser's own `Sec-Fetch-Site`
   says cross-site, or, absent that header, when `Origin` names another
   host. A request with neither header is allowed (a non-browser client
   holding the cookie; an attacker's page cannot strip `Origin`). Bearer
   surfaces (`/api/v1`, `/api/scim`, `/api/webhooks`) are exempt because a
   cross-site page cannot attach a bearer credential. The check runs before
   the public-path decision, so a cross-site POST to login or signup is
   refused too. After the independent review (L7): the check covers the
   CMS cookie (`payload-token`) as well as the session cookie; `same-site`
   (a sibling subdomain) is refused, not allowed; and `Origin` is compared
   against `Host`, never a forwarded host header, because that header is
   client-writable when no proxy sets it.

3. **A health check exists and says nothing useful to an attacker.**
   `GET /api/health` is public, rate-limited by address, returns booleans
   and fixed words (database reachable, migrations applied, cache,
   storage, job sources, mart freshness), `503` only when a request could
   not be served, `degraded` when something operational is off, never a
   host, a version, a count, a backend name or an error text. After the
   review (M3): the answer is memoised per instance for ten seconds, and a
   per-instance budget across every address bounds the database cost
   whatever a caller writes into a forwarded header.

4. **Logs are redacted at the one place an unhandled error is logged.**
   `src/lib/log.ts` strips connection-string credentials, bearer and basic
   credentials, JWTs, provider key shapes, our own API keys, email
   addresses and phone numbers; every server-side error log goes through
   `redactError`, never the error object - the review (M2) found nine
   sites that still logged it raw, and a static scan of every
   `console.error` / `console.warn` under `src` now refuses one. A log
   line that carries any of those is itself a Sev 2 finding
   (`INCIDENT_RESPONSE.md`). The redactor never throws, carries a redacted
   `cause`, and leaves an invoice or ticket number readable (L2, L3).

5. **Account erasure is code, scheduled, and scrub-in-place.**
   `src/lib/privacy/erasure.ts`: a request is scheduled fourteen days out
   and cancellable; a live subscription blocks it; execution deletes the
   person's own tables (profile, evidence, résumés, applications and their
   folders — the submitted document versions leave through the Application
   cascade the Stage 09 trigger allows — agents, plans, mailbox connections
   after their own revocation, sessions, keys, identities, notifications,
   per-person marts and usage, billing profile, payment methods, the CRM
   record, the sensitive schema through its own module), scrubs the `User`
   row in place (the address becomes `erased-<id>@erased.invalid`, the
   name `Erased user`, the hash unverifiable), scrubs the identity on other
   parties' records (a provider's case, an agency's representation, a
   support ticket) and marks memberships removed, removes the person's
   files from the object store, and writes one audit row with counts. Never
   deleted: audit rows, consent records, invoices, payments, refunds,
   credit notes, placements. The person's own route
   (`/api/account/erasure`) and a control under Settings; never a staff
   action.

   After the independent review (H3, M1, L1, L10, M4): the question bank,
   webhook endpoints, queued outbound events and idempotency records are
   deleted too; the person's support messages, a referral where they were
   the referee, and the actor address, IP and user agent on the person's
   OWN audit rows are scrubbed (the rows stay; the hash-chain columns are
   unwired, so this is safe today and the chain, when wired, must hash a
   digest); the blockers (a live subscription, being the only owner of an
   organisation) are re-checked when the erasure runs and a request whose
   blocker reappeared is deferred and audited, never executed around;
   checkout and a trial refuse while an erasure is scheduled; the request
   row is claimed conditionally inside the transaction so a cancel can
   never be overwritten; the sweep re-executes a completed request whose
   person is not scrubbed (a restore to before the erasure); a submitted
   version attached to no application is immutable and its object is kept
   and counted. NOT reached: the payment provider's own customer record,
   which the control says.

6. **Retention is a sweep the matrix describes.** `npm run retention:sweep`
   (`src/lib/privacy/retention.ts`) removes what `DATA_RETENTION_MATRIX.md`
   expires by platform default — sessions 30 days after expiry or
   revocation, AI runs two years, rollup runs one year, mailbox references
   180 days, aggregate marts three years — executes due erasures, retries
   failed file purges, and audits itself. The matrix now carries an
   enforcement column per row: ENFORCED BY SWEEP, ON EVENT, STATUTORY
   KEEP, PER CONTRACT, NOT AUTOMATED.

7. **Accessibility is a measurement over rendered pages.** `npm run a11y`
   runs axe-core (WCAG 2.0/2.1/2.2 A and AA) in Chromium over 42 pages
   of a built, started application — public, candidate and console — with
   one stored session, and CI runs it as its own job. The first run found
   real defects (three colour tokens under 4.5:1 on every page; a combobox
   naming an absent listbox; unlabelled filters; 13 px checkboxes; inline
   links indistinguishable from text; pages without a `main` landmark);
   all were fixed and the run is green. What axe cannot judge is not
   claimed.

8. **Performance is a budget and a repeatable measurement, labelled
   local.** `docs/operations/PERFORMANCE_BUDGETS.md` sets p95 budgets per
   route and batch budgets for the Stage 21 rollup and extraction;
   `npm run perf:load` and `npm run perf:rollup` measure them and exit
   non-zero over budget. The recorded numbers are for a local build on the
   build machine; production is NOT measured.

9. **Backup and restore are scripts and a rehearsal; recovery and incident
   response are written procedures.** `npm run db:backup` / `db:restore`
   (custom-format dump WITH its privileges and a checksum; restore into an
   empty target with role creation, role membership, proof of history,
   RLS, counts AND of the tenant and sensitive paths), rehearsed twice
   against local PostgreSQL 16 with the log in `BACKUP_RESTORE.md` - the
   first rehearsal dropped the grants and passed every check while the
   tenant path could read nothing (review H2);
   `DISASTER_RECOVERY.md` proposes RPO/RTO per tier and the scenario
   responses; `INCIDENT_RESPONSE.md` is the runbook. The provider's PITR
   and a production-scale restore are NOT VERIFIED.

10. **Provenance is produced, not claimed.** CI generates a CycloneDX SBOM
    from the lockfile on every run; `dependency-review.yml` gates known
    advisories on pull requests; a static test refuses secret-shaped strings
    in tracked files and a tracked `.env`.

## Consequences

- Readiness gates re-measured (`PRODUCTION_READINESS_GATES.md`): CSRF,
  log redaction, erasure, retention enforcement, health checks, backups,
  restore rehearsal, DR plan and accessibility move from FAIL / NOT
  VERIFIED to PASS (local) or PARTIAL with the remaining condition named;
  penetration test, provider PITR, monitoring/alerting with on-call, SLOs,
  rollback rehearsal and a nonce CSP stay open and say so.
- Two new operator commands join the sweep family (`retention:sweep`,
  `db:backup`), and three measurement commands (`a11y`, `perf:load`,
  `perf:rollup`).
- Three colour tokens changed platform-wide (`--faint`, `--brand-500`,
  `--success`, `--warn`); the dark theme's values were not measured (axe
  ran the light theme) and are stated as such.
- The demo account is seeded as `admin` so the console can be audited; the
  two-lock (`STAFF_EMAILS`) still decides whether it is staff. After the
  review (M7): the seed never creates the demo account in production and
  never re-elevates it on a reseed.
- `Strict-Transport-Security: includeSubDomains` commits every subdomain
  of the deployed host to TLS; deploy at a host whose subdomains you
  control. `Cross-Origin-Opener-Policy: same-origin` would break a
  popup-based OAuth or payment SDK; none exists.
- The `AuditLog` hash-chain columns are unwired (Stage 03 evidence item
  21). The readiness gate and the retention matrix said "hash-chained";
  both were corrected in this review.

## Not done, stated

- Third-party penetration test (external action; commissioned by the
  founder).
- A nonce-based `script-src` (Stage 24).
- Shared rate-limit store (in-process, single instance; R-16).
- Provider PITR rehearsal, production-scale restore timing, a status page,
  monitoring and on-call, SLOs (Stage 24).
- Accessibility of the dark theme, of interactions axe cannot drive, and
  of the mobile app (never run on a device).
- Production performance and Core Web Vitals.
- Retention of employer pipelines (3 years) and staffing records (7 years)
  is NOT AUTOMATED: contract terms, not platform defaults.

## Alternatives considered

- **A strict CSP now, with `'unsafe-inline'`** — rejected: it would
  advertise a policy while permitting exactly what the policy exists to
  stop.
- **Hard-deleting the user row on erasure** — rejected: invoices, payments
  and placements restrict it and are statutory or contractual; scrub in
  place keeps the audit chain's subject stable.
- **Immediate erasure** — rejected: irreversible, and a compromised session
  could destroy an account; fourteen days is the grace the request page
  states.
- **Running axe in `npm test` with a mocked renderer** — rejected: the
  defects found were in rendered CSS and real DOM; only a browser over the
  built app finds them.
