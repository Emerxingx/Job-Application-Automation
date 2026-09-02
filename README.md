# JobPilot AI

Your AI-powered career co-pilot for the Canadian and US job markets. Smart, automated, personalized.

JobPilot scans live job postings for the titles you want, scores your real chance of getting
through the screen, rewrites your resume for each posting, prepares the whole application for
you to confirm, and keeps a complete, auditable folder for every application you send.

---

## Architecture baseline and production programme

A full evidence-based architecture audit lives in [`docs/`](docs/). Start with
[`docs/programme/CURRENT_BASELINE.md`](docs/programme/CURRENT_BASELINE.md) for the
measured state of this repository, and [`docs/adr/`](docs/adr/) for the decisions
behind the target architecture. `HANDOFF.md` remains the prior engineering handoff.

> **On "applies on your behalf".** JobPilot submits programmatically only where an
> employer has authorized an ATS API. Everywhere else the application is
> **prepared in full and confirmed by the applicant** — a deliberate decision
> recorded in
> [`docs/adr/ADR-0016-application-automation.md`](docs/adr/ADR-0016-application-automation.md),
> because the major job boards prohibit automated submission and enforce it
> against the *applicant's* account. The dashboard's auto-apply toggle is
> disabled and labelled accordingly; nothing is ever submitted unattended.

---

## Quick start

```bash
npm install          # installs deps and generates the Prisma client
cp .env.example .env # defaults work as-is; no API keys required
npm run db:push      # create the SQLite database
npm run db:seed      # load plans + a demo account
npm run dev          # http://localhost:3000
```

**Demo account:** `demo@jobpilot.ai` / `demo1234`

Sign in, hit **Scan all agents** on the dashboard, then open the job feed, select some roles and
apply. Each application produces a folder under `storage/` you can open from the app.

---

## What it does

| Capability | Where |
|---|---|
| **Job agents** — one per career track, with titles, locations, salary floor, exclusions and a match threshold | `/dashboard/agents` |
| **Live scanning** — pulls postings and scores each against your resume | `src/lib/services/scanner.ts` |
| **Match scoring** — a 0–100 score broken into skills, experience, keywords, seniority and location, with the terms you match and miss | `src/lib/providers/ai/` |
| **Resume tailoring** — headline mirrored, skills reordered, achievements led with relevance, ATS-safe formatting | `src/lib/providers/ai/mock.ts` |
| **Bulk apply** — select any number of jobs and apply to all of them at once | `/dashboard/jobs` |
| **Application folders** — job description as captured, the exact resume and cover letter submitted, and a report of what changed | `src/lib/storage.ts` |
| **Interview prep** — likely questions with model answers, STAR stories from your real roles, company research | `/dashboard/interview-prep` |
| **Subscriptions** — monthly / quarterly / annual across three tiers, with a monthly application allowance | `src/lib/subscription.ts` |

### Scoring integrity

Two rules the scoring engine enforces, because the product is only useful if the number is honest:

- **Domain fit gates the total.** Experience, seniority and location cannot carry a score on their
  own. A senior analyst applying to a backend engineering role scores in the low 20s, not the mid
  40s, because they cannot do the job.
- **Keywords are measured against the posting's requirements**, not its benefits blurb and EEO
  boilerplate — text no resume ever contains, which would otherwise depress every candidate equally.

### Tailoring integrity

Tailoring only rephrases, reorders and reframes experience already in your resume. It never invents
an employer, title, date, credential or accomplishment, and it strips posting qualifiers such as
"(Bilingual)" from your headline rather than asserting them about you. Every change is listed in the
`tailoring-report.md` in the application's folder.

---

## Architecture

```
src/
├── app/
│   ├── page.tsx              marketing landing page
│   ├── (auth)/               login, signup
│   ├── onboarding/           resume → first agent
│   ├── dashboard/            the product
│   └── api/                  REST endpoints
├── components/               UI, design system in components/ui.tsx
└── lib/
    ├── providers/            pluggable integrations (see below)
    ├── services/             scanner + applicator pipelines
    ├── storage.ts            application folder generation
    ├── subscription.ts       plans, quota, billing periods
    └── auth.ts               JWT session cookies
```

**Stack:** Next.js 15 (App Router) · TypeScript · Tailwind · Prisma · SQLite (dev) / Postgres (prod)

### The provider layer

Every external integration sits behind an interface with a working mock, so the app runs fully with
zero API keys. Swapping in a real service means implementing one interface and setting an env var —
no application code changes.

| Provider | Interface | Default | Real option |
|---|---|---|---|
| Jobs | `src/lib/providers/jobs/types.ts` | `mock` — realistic CA/US postings | Indeed, Adzuna, a scraper |
| AI | `src/lib/providers/ai/types.ts` | `mock` — deterministic scoring engine | `anthropic` (Claude) |
| Payments | `src/lib/providers/payments/index.ts` | `mock` — activates instantly | Stripe |

The mock AI provider is **not** random numbers — it is a real keyword and semantic analysis engine,
so scores are explainable, stable, and the same pairing always produces the same result.

To use Claude for tailoring and interview prep:

```bash
AI_PROVIDER="anthropic"
ANTHROPIC_API_KEY="sk-ant-..."
```

The deterministic engine still runs first and grounds the model with its keyword analysis, and
serves as the fallback if a call fails — so an API problem degrades quality rather than breaking
an application.

---

## Deploying

1. Set `provider = "postgresql"` in `prisma/schema.prisma` and point `DATABASE_URL` at Postgres.
2. Set a strong `AUTH_SECRET` (32+ characters). The app refuses to start in production without one.
3. Point `STORAGE_ROOT` at durable storage (or object storage) — application documents are also
   kept in the database, so downloads still work on an ephemeral filesystem.
4. `npm run build && npm start`

---

## Roadmap

The data model already carries Canadian NOC codes on every posting, so the planned modules build on
the profile that exists: **Learning Paths**, **Change Your Career**, and **Most Sought-After
Certifications by NOC code**. The API is UI-agnostic, so a React Native mobile client can consume
the same endpoints.

---

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run db:push` | Sync schema to the database |
| `npm run db:seed` | Load plans and the demo account |
