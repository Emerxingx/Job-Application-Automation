# Deploying JobPilot AI

The app runs locally with no third-party accounts: every provider falls back to
a mock implementation. Going to production means replacing three of those mocks
and changing two things that only work on a machine with a persistent disk.

## 1. Database — required

Local development uses SQLite, which will not survive on a serverless host: the
filesystem is read-only at runtime and `/tmp` is discarded between invocations.

Prisma resolves the datasource provider at generate time and **rejects
`env()` for the `provider` field** (verified with `prisma validate`), so this is
a one-line schema edit rather than a configuration switch:

```prisma
// prisma/schema.prisma
datasource db {
  provider = "postgresql"   // was "sqlite"
  url      = env("DATABASE_URL")
}
```

The rest of the schema is already portable — it validates cleanly against
PostgreSQL with no other changes. Then:

```bash
DATABASE_URL="postgresql://…" npx prisma db push
DATABASE_URL="postgresql://…" npm run db:seed   # seeds the three plans
```

The seed is what creates the Starter / Professional / Executive plan rows. A
deployment without it has no plans for checkout to reference.

## 2. Application folders — decide before launch

`createApplicationFolder` writes each application's files to local disk under
`STORAGE_ROOT`. On a serverless host those files disappear when the instance
does.

This is already partly mitigated: the tailored resume, cover letter and job
description are also stored as database columns, and both the detail page and
the download route fall back to them when the folder is missing. So the
**content survives** — what is lost on a restart is `README.md` and
`tailoring-report.md`, which are rendered from data the database still holds.

Two workable options:

- **Persistent disk** (a VM, a container with a volume, Railway, Fly, Render):
  set `STORAGE_ROOT` to the mounted path and everything works as it does
  locally.
- **Object storage** (S3, R2, Vercel Blob): replace the `fs` calls in
  `src/lib/storage.ts`. The module already has a narrow interface —
  `createApplicationFolder`, `listFolder`, `readFolderFile` — so this is a
  contained change.

Until one of those is done, prefer a host with a real filesystem.

## 3. Providers

| Variable | Effect |
| --- | --- |
| `AI_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` | Real resume tailoring, match scoring and interview prep. Without it, the local scoring engine runs — which works, but is not the product's selling point. |
| `JOB_PROVIDER=adzuna` + `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` | Live Canadian and US postings. Free tier at <https://developer.adzuna.com>. |
| `PAYMENT_PROVIDER=stripe` + `STRIPE_SECRET_KEY` | Real checkout. |

Each falls back to its mock with a warning if the credential is missing, so a
partial configuration degrades rather than crashes.

### Stripe

1. Create a Price for every plan and interval you sell (three plans × three
   intervals = nine).
2. Map them, either individually or as one JSON blob:

   ```bash
   STRIPE_PRICE_PROFESSIONAL_MONTHLY=price_…
   # or
   STRIPE_PRICE_MAP='{"professional:monthly":"price_…","executive:annual":"price_…"}'
   ```

3. Add a webhook endpoint pointing at `POST /api/webhooks/stripe`, subscribed to
   `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted` and `invoice.payment_failed`. Put its signing
   secret in `STRIPE_WEBHOOK_SECRET`.

The webhook — not the browser redirect — is what activates a subscription. A
customer who closes the tab after paying still gets their plan, and a customer
who edits the success URL gets nothing. The handler returns 500 on failure so
Stripe retries rather than dropping the event.

### Apply mode

`APPLY_MODE` controls how applications reach employers:

- `mock` — simulated; the default while `JOB_PROVIDER=mock`.
- `auto` — submit through an authorized ATS API where one is available, prepare
  an assisted application everywhere else. The default once a live job source is
  configured.
- `assisted` — never submit on the applicant's behalf.

Programmatic submission additionally requires a credential the **employer**
issues for their board (`ATS_GREENHOUSE_<BOARD>`, `ATS_LEVER_<BOARD>`). Without
one, `auto` behaves exactly like `assisted`. This is deliberate: the major job
boards prohibit automated submission and enforce it against the *applicant's*
account, so the engine does not drive their forms.

## 4. Secrets

`AUTH_SECRET` signs session cookies. The committed default is a development
placeholder — **replace it**, or every session token is forgeable by anyone who
has read the repository.

```bash
AUTH_SECRET=$(openssl rand -base64 32)
```

Also set `NEXT_PUBLIC_APP_URL` to the real origin; Stripe's success and cancel
URLs are built from it.

## 5. Known limits at scale

- **Rate limiting is per instance.** `src/lib/rate-limit.ts` keeps counters in
  process memory, so with N instances the effective ceiling is N × the
  configured limit. Correct for a single instance; move the store to Redis
  before scaling horizontally. The exported interface is what a shared
  implementation has to satisfy.
- **Adzuna returns snippets, not full postings.** Tailoring is sharper when the
  complete description is available; fetching it from `applyUrl` is a worthwhile
  follow-up.
- **Scans are synchronous.** A user with many agents waits for the whole fan-out.
  Moving scans to a queue is the first thing to do when scan latency starts
  showing up in support requests.

## Pre-launch checklist

- [ ] `provider = "postgresql"` and `DATABASE_URL` set
- [ ] `npm run db:push && npm run db:seed` run against production
- [ ] `AUTH_SECRET` replaced with a generated value
- [ ] `NEXT_PUBLIC_APP_URL` set to the real origin
- [ ] Storage decision made (persistent disk or object storage)
- [ ] Stripe prices created, mapped, and the webhook registered
- [ ] `APPLY_MODE` set deliberately
- [ ] `npm run check` passes (types + tests)
