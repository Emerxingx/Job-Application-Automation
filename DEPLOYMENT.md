# Deploying JobPilot AI

The app runs locally with no third-party accounts: every provider falls back to
a mock implementation. Going to production means replacing three of those mocks
and changing two things that only work on a machine with a persistent disk.

The headless CMS (section 3) runs inside this same app and needs no extra
service — only its own secret and, for multi-instance deployments, its own
database.

## 1. Database — required

The transactional store is **PostgreSQL only** (`ADR-0002`); SQLite was removed
in Stage 01 because the tenancy backstop is row-level security, which SQLite
does not have. Two connection strings are required:

| Variable | Used by | On Supabase |
| --- | --- | --- |
| `DATABASE_URL` | the application at runtime | the **transaction-mode pooler**, port 6543, with `?pgbouncer=true` |
| `DIRECT_URL` | `prisma migrate` | the session-mode pooler or direct host, port 5432 |

A password containing URL-reserved characters is handled: both values are
percent-encoded by `src/lib/db-url.ts` before any parser sees them.

Schema changes are **versioned migrations**, never `db push`:

```bash
DIRECT_URL="postgresql://…:5432/…" npx prisma migrate deploy   # apply the history
npx prisma migrate diff --from-url "$DIRECT_URL" --to-schema-datamodel prisma/schema.prisma --exit-code
DATABASE_URL="postgresql://…" npm run db:seed                  # seeds the three plans + demo account
```

Take a restore point before every `migrate deploy`; the full procedure,
review standard and recovery plan are in
`docs/operations/DATABASE_MIGRATIONS.md`. The seed is what creates the
Starter / Professional / Executive plan rows. A deployment without it has no
plans for checkout to reference.

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

## 3. Headless CMS (Payload)

The CMS runs **inside this same Next.js app** — there is no second service to
deploy:

| Surface | Path |
| --- | --- |
| Admin UI | `/admin` |
| REST API | `/api/cms/*` |
| GraphQL | `/api/cms/graphql` |

It is mounted at `/api/cms` rather than Payload's default `/api` specifically
so its catch-all route can never shadow the application's own endpoints
(`/api/apply`, `/api/auth/*`, `/api/webhooks/stripe`, …). Verified: with the
CMS mounted, `/api/apply` still returns 401 rather than a CMS 404.

### Two databases, on purpose

`PAYLOAD_DATABASE_URI` is separate from `DATABASE_URL`:

- **Prisma** owns transactional product data — users, jobs, applications,
  subscriptions. The tables that drive billing and quota enforcement.
- **Payload** owns editorial content — pages, blog posts, learning paths,
  career guides, certifications.

Different lifecycles and different restore stories: rolling back a bad content
edit should never risk customer subscription records. Nothing in the CMS reads
or writes a Prisma table.

One deliberate consequence: **pricing numbers are not in the CMS.** Plan
prices, quotas and features live in Prisma's `Plan` table because they drive
real checkout and quota enforcement. The `pricing-copy` global holds only the
surrounding heading and FAQ text. If the amounts lived in both places, a
content edit could silently disagree with what a customer is charged.

### First run

Visit `/admin`. Payload prompts to create the first editor account, then that
account manages the rest (`Editors` collection, roles: admin / editor).

The public site does not depend on the CMS having content. Every accessor in
`src/lib/cms.ts` returns `null` rather than throwing, and the landing page
falls back to its built-in copy — so an empty CMS, or an unreachable one,
never takes the front page down. Verified both directions: publishing a `home`
page overrides the hero live, and deleting it restores the built-in copy.

### Production notes

- `PAYLOAD_SECRET` must be a generated value. It is validated the same way as
  `AUTH_SECRET`, including rejecting the `.env.example` placeholder by value —
  the placeholder is long enough to pass a naive length check. The two secrets
  are deliberately distinct so a single leak cannot compromise both editor and
  job-seeker sessions.
- The guard intentionally does **not** fire during `next build`
  (`NEXT_PHASE=phase-production-build`), so CI can build without runtime
  secrets. It fires at server start, which is what actually matters.
- **No email adapter is configured.** Editor password-reset emails are written
  to the server console. Add a Payload email adapter before real editors rely
  on self-service password resets.
- Uploaded media is written to `media/` on local disk — the same
  persistent-storage caveat as `storage/` in section 2 applies.
- The CMS adapter is chosen from `PAYLOAD_DATABASE_URI`'s scheme: a `file:`
  path selects SQLite (local only); a `postgres://` / `postgresql://` URL
  selects PostgreSQL. Production uses a **separate logical database** on the
  same managed instance as `DATABASE_URL` — never the same database.

### Regenerating CMS artifacts

After changing collections or fields:

```bash
npm run cms:types      # regenerate src/payload-types.ts
npm run cms:importmap  # regenerate the admin import map
```

Both run through `scripts/payload-cli.mjs`. Payload's CLI requires an ESM
project, while this app builds and runs correctly as CommonJS — the wrapper
toggles `"type": "module"` for the duration of the command and restores
`package.json` afterwards, including on failure or Ctrl-C. Converting the whole
project to ESM purely to satisfy a codegen tool would have meant rewriting the
lazy `require()` provider loads for no runtime benefit.

## 4. Providers

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

## 5. Secrets

`AUTH_SECRET` signs session cookies. The committed default is a development
placeholder — **replace it**, or every session token is forgeable by anyone who
has read the repository.

```bash
AUTH_SECRET=$(openssl rand -base64 32)
```

Also set `NEXT_PUBLIC_APP_URL` to the real origin; Stripe's success and cancel
URLs are built from it.

### Redis — optional

The CMS fast-read cache (`src/lib/cache/`) backs the ATS-ruleset and prompt
lookups on the automation engine's hot path. With no configuration it uses a
process-local TTL map, which is correct for a single instance and needs nothing
installed.

To share the cache across instances, set `REDIS_URL` **and** install the client,
which is deliberately not a package.json dependency:

```bash
npm install ioredis
```

The two go together. `ioredis` is loaded through Node's resolver at runtime, so
an install without it builds and boots normally; but if `REDIS_URL` is set while
the package is missing, cache construction throws and the app logs
`[cache] REDIS_URL set but Redis init failed` and falls back to the in-memory
map — working, but not shared. Check that line in the logs after a deploy that
turns Redis on.

## 6. Known limits at scale

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
- [ ] `PAYLOAD_SECRET` replaced with a generated value (distinct from `AUTH_SECRET`)
- [ ] First CMS editor account created at `/admin`
- [ ] Stripe prices created, mapped, and the webhook registered
- [ ] `APPLY_MODE` set deliberately
- [ ] `npm run check` passes (types + tests)
