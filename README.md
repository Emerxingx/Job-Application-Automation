# JobPilot AI 🍁

Your AI-powered career co-pilot for Canada's job market. Smart, automated, personalized.

JobPilot AI helps job seekers search postings, track applications through
their pipeline, and generate tailored cover letters and resume bullet points
for a specific job — grounded in the candidate's own background, powered by
Claude.

## Features

- **Find jobs** — search and filter postings by keyword, location (including
  "remote"), and job type.
- **AI-tailored applications** — generate a draft cover letter or a set of
  tailored resume bullet points for any job, based on your profile and base
  resume. Claude is instructed to only draw on what's actually in your
  profile — never to invent employers, credentials, or metrics.
- **Application tracker** — save jobs and move them through
  Saved → Applied → Interviewing → Offer / Rejected.
- **Profile** — one place to maintain your base resume, target roles, and
  skills, used to ground every AI generation.

## Tech stack

- [Next.js](https://nextjs.org/) (App Router) + TypeScript + React
- [Tailwind CSS](https://tailwindcss.com/) v4
- [`@anthropic-ai/sdk`](https://github.com/anthropics/anthropic-sdk-typescript) for AI generation (Claude Opus 5 by default)
- Local JSON-file persistence (no database required to run)

## Getting started

```bash
npm install
cp .env.example .env.local   # then add your ANTHROPIC_API_KEY
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The AI generation
buttons ("Generate cover letter" / "Tailor resume bullets") require an
Anthropic API key — get one at
[console.anthropic.com](https://console.anthropic.com/). Everything else
(browsing jobs, tracking applications, editing your profile) works without
one.

### Environment variables

| Variable            | Required | Description                                                        |
| -------------------- | -------- | -------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`  | For AI features | Your Anthropic API key.                                       |
| `ANTHROPIC_MODEL`    | No       | Override the model used for generation (defaults to `claude-opus-5`). |

## Project structure

```
app/
  page.tsx                     Dashboard
  jobs/page.tsx                Job search & listing
  jobs/[id]/page.tsx           Job detail + AI actions
  applications/page.tsx        Application tracker board
  profile/page.tsx             Profile editor
  api/
    jobs/                      Job search & detail endpoints
    applications/              Application CRUD endpoints
    profile/                   Profile read/write endpoint
    generate/
      cover-letter/            POST -> Claude-generated cover letter
      resume-bullets/          POST -> Claude-generated resume bullets
components/                    Shared UI (NavBar, JobCard, StatusBadge, JobActions)
lib/
  types.ts                     Job / Application / Profile types
  jobs.ts                      Seed job data + search/filter
  store.ts                     JSON-file persistence for profile & applications
  claude.ts                    Anthropic SDK integration
data/                          Runtime JSON storage (git-ignored, created on first run)
```

## Data & privacy

Your profile and tracked applications are stored locally in `data/*.json`
(git-ignored). Nothing leaves the app except when you click a "Generate"
button, which sends your profile and the selected job's description to the
Anthropic API to produce that one response.

## Current limitations & roadmap

This is an early scaffold, not a production deployment:

- **Job data is seed/demo data.** `lib/jobs.ts` ships ~15 mock Canadian
  postings at fictional companies so search, detail, and tracking all work
  end-to-end. Swap `searchJobs` / `getJobById` for a real source (e.g. the
  Job Bank of Canada API, or a job-search API) to go live — nothing else in
  the app needs to change.
- **Single-user, file-based storage.** `lib/store.ts` persists to local JSON
  files, which is enough for local/demo use but isn't safe for concurrent
  writers. Move to a real database (e.g. Postgres via Prisma) before
  supporting multiple users.
- **No authentication.** Add auth before deploying anywhere multi-tenant.
- **No resume file upload/parsing.** The profile takes plain-text resume
  content today; PDF/DOCX upload and parsing is a natural next step.
- **No real "Apply" flow.** Apply links are placeholders until a live
  job-board integration is connected.
