import Link from 'next/link';
import {
  ArrowRight,
  BrainCircuit,
  CheckCircle2,
  FolderTree,
  Gauge,
  MessagesSquare,
  Radar,
  ShieldCheck,
  Sparkles,
  Target,
} from 'lucide-react';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { PricingTable } from '@/components/pricing-table';
import { parseJson } from '@/lib/types';
import { SiteHeader } from '@/components/site-header';
import { getLandingContent } from '@/lib/cms';

/**
 * Built-in hero copy.
 *
 * This is the fallback, not dead code: it renders until an editor publishes a
 * `home` page in the CMS, so a fresh install (or an unreachable CMS) still
 * shows a complete landing page rather than an empty shell.
 */
const DEFAULT_HERO = {
  eyebrow: 'Built for the Canadian & US job market',
  headline: 'Stop applying to jobs.',
  headlineAccent: 'Start getting interviews.',
  subheadline:
    'JobPilot AI scans live postings for the titles you want, scores your real chance of getting through the screen, rewrites your resume for each role, and applies — keeping a complete, auditable folder for every single application.',
  primaryCtaLabel: 'Start your search',
  primaryCtaHref: '/signup',
  secondaryCtaLabel: 'Try the live demo',
  secondaryCtaHref: '/login?demo=1',
} as const;

export default async function LandingPage() {
  const [plans, user, cms] = await Promise.all([
    db.plan.findMany({ orderBy: { sortOrder: 'asc' } }),
    getCurrentUser(),
    getLandingContent(),
  ]);

  // CMS content wins field by field, so a partially-filled hero still renders
  // a complete page instead of blanking whatever the editor left empty.
  const hero = { ...DEFAULT_HERO, ...(cms.hero ?? {}) };

  const planData = plans.map((p) => ({
    code: p.code,
    name: p.name,
    tagline: p.tagline,
    monthlyPriceCents: p.monthlyPriceCents,
    quarterlyPriceCents: p.quarterlyPriceCents,
    annualPriceCents: p.annualPriceCents,
    applicationsPerMonth: p.applicationsPerMonth,
    maxAgents: p.maxAgents,
    features: parseJson<string[]>(p.features, []),
    highlight: p.highlight,
  }));

  return (
    <div className="min-h-screen bg-bg">
      <SiteHeader signedIn={Boolean(user)} />

      <main>

      {/* Hero */}
      <section className="relative overflow-hidden px-4 pb-20 pt-16 sm:pt-24">
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-0 h-[420px] w-[820px] -translate-x-1/2 rounded-full bg-brand-500/10 blur-3xl"
        />
        <div className="relative mx-auto max-w-4xl text-center">
          {hero.eyebrow && (
            <span className="chip mx-auto mb-6 border border-line bg-surface px-3 py-1.5">
              <Sparkles className="h-3.5 w-3.5 text-brand-500" />
              {hero.eyebrow}
            </span>
          )}

          <h1 className="text-balance text-4xl font-bold tracking-tight text-ink sm:text-6xl">
            {hero.headline}
            {hero.headlineAccent && (
              <>
                <br />
                <span className="text-brand-500">{hero.headlineAccent}</span>
              </>
            )}
          </h1>

          {hero.subheadline && (
            <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg text-muted">
              {hero.subheadline}
            </p>
          )}

          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Link
              href={hero.primaryCtaHref || DEFAULT_HERO.primaryCtaHref}
              className="btn-primary px-6 py-3 text-base"
            >
              {hero.primaryCtaLabel || DEFAULT_HERO.primaryCtaLabel}
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href={hero.secondaryCtaHref || DEFAULT_HERO.secondaryCtaHref}
              className="btn-secondary px-6 py-3 text-base"
            >
              {hero.secondaryCtaLabel || DEFAULT_HERO.secondaryCtaLabel}
            </Link>
          </div>

          <p className="mt-4 text-xs text-faint">
            No credit card required · Cancel anytime · Your data stays yours
          </p>
        </div>

        {/* Proof strip */}
        <div className="relative mx-auto mt-16 grid max-w-4xl grid-cols-2 gap-4 sm:grid-cols-4">
          {[
            { value: '400', label: 'applications / month' },
            { value: '< 60s', label: 'per tailored application' },
            { value: '100%', label: 'documented & auditable' },
            { value: '2', label: 'countries covered' },
          ].map((s) => (
            <div key={s.label} className="card p-4 text-center">
              <p className="text-2xl font-bold text-ink">{s.value}</p>
              <p className="mt-1 text-xs text-muted">{s.label}</p>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="border-t border-line bg-surface/50 px-4 py-20">
        <div className="mx-auto max-w-6xl">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">
              Four steps, fully automated
            </h2>
            <p className="mt-3 text-muted">
              Set it up once. Your agents work while you get on with your life.
            </p>
          </div>

          <ol className="mt-14 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            {[
              {
                icon: Radar,
                step: 'Step 1',
                title: 'Create your job agents',
                body: 'Name the titles you want — "Senior Data Analyst", "Product Manager" — plus your locations, salary floor and deal-breakers. Run one agent per career track.',
              },
              {
                icon: Gauge,
                step: 'Step 2',
                title: 'See your real odds',
                body: 'Every live posting is scored against your actual experience, with the matched and missing keywords shown. You decide what is worth applying to.',
              },
              {
                icon: BrainCircuit,
                step: 'Step 3',
                title: 'Resume rewritten per role',
                body: 'Your resume is restructured for each posting — headline mirrored, skills reordered, achievements led with relevance — so it clears ATS filters and holds a recruiter.',
              },
              {
                icon: FolderTree,
                step: 'Step 4',
                title: 'Every application filed',
                body: 'Each application gets a folder: the job description as posted, the exact resume and cover letter sent, and a report of what changed. Nothing is a black box.',
              },
            ].map((item) => (
              <li key={item.title} className="card p-6">
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-brand-500/10">
                  <item.icon className="h-5 w-5 text-brand-500" />
                </div>
                <p className="text-xs font-semibold uppercase tracking-wide text-brand-500">
                  {item.step}
                </p>
                <h3 className="mt-1.5 text-base font-semibold text-ink">{item.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{item.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="px-4 py-20">
        <div className="mx-auto max-w-6xl">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">
              Everything the search actually requires
            </h2>
            <p className="mt-3 text-muted">
              Not just a mass-apply button — the whole pipeline, from discovery to the interview.
            </p>
          </div>

          <div className="mt-14 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {[
              {
                icon: Target,
                title: 'Match scoring you can interrogate',
                body: 'A single number, broken into skills, experience, keywords, seniority and location — with the exact terms you match and the ones you are missing.',
              },
              {
                icon: Sparkles,
                title: 'ATS-first resume tailoring',
                body: 'Single column, parser-safe formatting, the job title mirrored in your headline, and posting keywords surfaced where they are genuinely supported by your history.',
              },
              {
                icon: MessagesSquare,
                title: 'Interview preparation',
                body: 'For any application, generate likely questions with model answers, STAR stories drafted from your real roles, company research and questions to ask them.',
              },
              {
                icon: FolderTree,
                title: 'A folder per application',
                body: 'Company, title, posting date, the description as captured, the customized resume and cover letter submitted, and a tailoring report. Downloadable, always.',
              },
              {
                icon: ShieldCheck,
                title: 'Never fabricates experience',
                body: 'Tailoring rephrases, reorders and reframes what you already have. No invented employers, titles, dates or credentials — ever. You can verify every change.',
              },
              {
                icon: BrainCircuit,
                title: 'Built to grow with you',
                body: 'Learning paths, career changes and the certifications that matter for your NOC code are on the roadmap — on the same profile and the same data.',
              },
            ].map((f) => (
              <div key={f.title} className="card p-6">
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-raised">
                  <f.icon className="h-5 w-5 text-brand-500" />
                </div>
                <h3 className="text-base font-semibold text-ink">{f.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="border-t border-line bg-surface/50 px-4 py-20">
        <div className="mx-auto max-w-6xl">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">
              Pick your application volume
            </h2>
            <p className="mt-3 text-muted">
              Every plan includes AI tailoring, application folders and match scoring. Commit for
              longer and pay less per month.
            </p>
          </div>

          <div className="mt-12">
            <PricingTable plans={planData} signedIn={Boolean(user)} />
          </div>
        </div>
      </section>

      {/* Roadmap */}
      <section className="px-4 py-20">
        <div className="mx-auto max-w-4xl text-center">
          <h2 className="text-3xl font-bold tracking-tight text-ink">More than applications</h2>
          <p className="mx-auto mt-3 max-w-2xl text-muted">
            JobPilot is built as a career platform. These modules plug into the profile you already
            have.
          </p>
          <div className="mt-10 grid gap-4 sm:grid-cols-3">
            {[
              { title: 'Learning Paths', body: 'Close the skill gaps your match scores keep surfacing.' },
              { title: 'Change Your Career', body: 'Map your transferable skills onto a new occupation.' },
              {
                title: 'Certifications by NOC',
                body: 'The credentials Canadian employers actually ask for, by job code.',
              },
            ].map((m) => (
              <div key={m.title} className="card p-6 text-left">
                <span className="chip mb-3 bg-brand-500/10 text-brand-600">Coming soon</span>
                <h3 className="text-base font-semibold text-ink">{m.title}</h3>
                <p className="mt-1.5 text-sm text-muted">{m.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="px-4 pb-24">
        <div className="mx-auto max-w-4xl overflow-hidden rounded-3xl border border-line bg-gradient-to-br from-brand-500 to-brand-700 px-8 py-14 text-center">
          <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Your next role is already posted.
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-white/80">
            Set up your first agent in under five minutes and let it work while you sleep.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/signup"
              className="btn rounded-xl bg-white px-6 py-3 text-base font-semibold text-brand-700 hover:bg-white/90"
            >
              Create your account
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
          <ul className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-white/80">
            {['No credit card to start', 'Cancel anytime', 'Canada & US coverage'].map((t) => (
              <li key={t} className="flex items-center gap-1.5">
                <CheckCircle2 className="h-4 w-4" />
                {t}
              </li>
            ))}
          </ul>
        </div>
      </section>

      </main>

      <footer className="border-t border-line px-4 py-10">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 text-sm text-muted">
          <p className="font-semibold text-ink">JobPilot AI</p>
          <p>Your AI-powered career co-pilot for Canada &amp; the US.</p>
        </div>
      </footer>
    </div>
  );
}
