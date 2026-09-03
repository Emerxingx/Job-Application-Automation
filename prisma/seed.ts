import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { normalizeDatabaseUrl } from '../src/lib/db-url';
import { ensurePersonalWorkspace } from '../src/lib/tenancy/organizations';
import { CONSENT_VERSIONS, REQUIRED_AT_SIGNUP } from '../src/lib/consent';

const db = new PrismaClient({ datasourceUrl: normalizeDatabaseUrl(process.env.DATABASE_URL) });

const PLANS = [
  {
    code: 'starter',
    name: 'Starter',
    tagline: 'Test the waters with a focused search',
    monthlyPriceCents: 2900,
    quarterlyPriceCents: 7800, // ~10% off
    annualPriceCents: 27800, // ~20% off
    applicationsPerMonth: 25,
    maxAgents: 1,
    features: JSON.stringify([
      '25 automated applications per month',
      '1 job agent',
      'AI resume customization for every application',
      'AI-written cover letters',
      'Organized application folders',
      'Match score on every job',
      'Email support',
    ]),
    highlight: false,
    sortOrder: 1,
  },
  {
    code: 'professional',
    name: 'Professional',
    tagline: 'For an active, serious job search',
    monthlyPriceCents: 5900,
    quarterlyPriceCents: 15900,
    annualPriceCents: 56600,
    applicationsPerMonth: 120,
    maxAgents: 5,
    features: JSON.stringify([
      '120 automated applications per month',
      '5 job agents running in parallel',
      'Everything in Starter',
      'Auto-apply above your match threshold',
      'AI interview preparation with STAR stories',
      'Application tracking and outcomes',
      'Priority support',
    ]),
    highlight: true,
    sortOrder: 2,
  },
  {
    code: 'executive',
    name: 'Executive',
    tagline: 'Maximum reach, senior roles, full automation',
    monthlyPriceCents: 9900,
    quarterlyPriceCents: 26700,
    annualPriceCents: 95000,
    applicationsPerMonth: 400,
    maxAgents: 20,
    features: JSON.stringify([
      '400 automated applications per month',
      'Unlimited practical job agents (20)',
      'Everything in Professional',
      'Hourly job scanning for first-mover advantage',
      'Executive interview coaching',
      'Salary benchmarking by NOC code',
      'Dedicated success manager',
    ]),
    highlight: false,
    sortOrder: 3,
  },
];

const DEMO_RESUME = {
  fullName: 'Alex Morgan',
  headline: 'Senior Data Analyst',
  email: 'demo@jobpilot.ai',
  phone: '+1 (416) 555-0142',
  location: 'Toronto, ON',
  linkedinUrl: 'https://linkedin.com/in/alexmorgan-demo',
  portfolioUrl: '',
  summary:
    'Data analyst with 6 years of experience turning product and financial data into decisions that move revenue. Built the reporting layer for a 40-person commercial org and led the experimentation practice that now gates every pricing change.',
  skills: [
    'SQL',
    'Python',
    'Tableau',
    'dbt',
    'Snowflake',
    'A/B Testing',
    'Statistics',
    'Stakeholder Management',
    'Data Modelling',
    'Excel',
  ],
  experience: [
    {
      company: 'Northbridge Commerce',
      title: 'Senior Data Analyst',
      location: 'Toronto, ON',
      startDate: '2022-03',
      endDate: 'Present',
      bullets: [
        'Rebuilt the revenue reporting model in dbt, cutting month-end close from 9 days to 2 and eliminating three conflicting sources of truth.',
        'Designed and ran the pricing experimentation program: 40+ A/B tests that lifted annual contract value 12% year over year.',
        'Partnered with finance to forecast churn, surfacing a segment worth $2.1M in at-risk ARR that the retention team recovered 60% of.',
        'Mentored two junior analysts, both promoted within 18 months.',
      ],
    },
    {
      company: 'Halcyon Retail Group',
      title: 'Data Analyst',
      location: 'Toronto, ON',
      startDate: '2020-01',
      endDate: '2022-02',
      bullets: [
        'Owned merchandising analytics across 180 stores, building the Tableau suite used daily by regional managers.',
        'Automated a weekly inventory reconciliation in Python, saving roughly 15 analyst hours per week.',
        'Identified a stock allocation flaw that had cost an estimated $400K annually in lost sales.',
      ],
    },
    {
      company: 'Meridian Insights',
      title: 'Junior Analyst',
      location: 'Mississauga, ON',
      startDate: '2018-06',
      endDate: '2019-12',
      bullets: [
        'Produced recurring client reporting across a book of 25 mid-market accounts.',
        'Migrated legacy Excel reporting into SQL-backed dashboards, cutting turnaround from 3 days to same-day.',
      ],
    },
  ],
  education: [
    {
      institution: 'University of Toronto',
      credential: 'Honours BSc, Statistics',
      year: '2018',
      location: 'Toronto, ON',
    },
  ],
  certifications: [
    'Google Data Analytics Professional Certificate',
    'Tableau Desktop Specialist',
  ],
  projects: [
    {
      name: 'Rental market tracker',
      description:
        'Scraped and modelled 3 years of Toronto rental listings; published an interactive affordability dashboard.',
    },
  ],
};

async function main() {
  console.log('Seeding JobPilot AI...');

  // --- Plans ---------------------------------------------------------------
  for (const plan of PLANS) {
    await db.plan.upsert({
      where: { code: plan.code },
      create: plan,
      update: plan,
    });
  }
  console.log(`  ✓ ${PLANS.length} subscription plans`);

  // --- Demo account --------------------------------------------------------
  const professional = await db.plan.findUniqueOrThrow({ where: { code: 'professional' } });

  const passwordHash = await bcrypt.hash('demo1234', 10);
  const user = await db.user.upsert({
    where: { email: 'demo@jobpilot.ai' },
    create: {
      email: 'demo@jobpilot.ai',
      passwordHash,
      fullName: 'Alex Morgan',
      phone: '+1 (416) 555-0142',
      city: 'Toronto, ON',
      country: 'CA',
      headline: 'Senior Data Analyst',
      linkedinUrl: 'https://linkedin.com/in/alexmorgan-demo',
      workAuth: 'Canadian Citizen',
      onboardedAt: new Date(),
    },
    update: { passwordHash },
  });

  // Stage 01: every user owns a personal workspace, and the demo account has
  // consented to the current documents, exactly as a real signup would have.
  await ensurePersonalWorkspace(db, user);
  for (const purpose of REQUIRED_AT_SIGNUP) {
    const held = await db.consentRecord.findFirst({
      where: { userId: user.id, purpose, version: CONSENT_VERSIONS[purpose], revokedAt: null },
    });
    if (!held) {
      await db.consentRecord.create({
        data: { userId: user.id, purpose, version: CONSENT_VERSIONS[purpose], source: 'import' },
      });
    }
  }

  const now = new Date();
  const periodEnd = new Date(now);
  periodEnd.setMonth(periodEnd.getMonth() + 1);
  const renewsAt = new Date(now);
  renewsAt.setMonth(renewsAt.getMonth() + 1);

  await db.subscription.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      planId: professional.id,
      interval: 'monthly',
      status: 'active',
      renewsAt,
      periodStart: now,
      periodEnd,
      applicationsUsed: 0,
    },
    update: { planId: professional.id, status: 'active' },
  });

  const existingResume = await db.resume.findFirst({
    where: { userId: user.id, isMaster: true },
  });
  if (existingResume) {
    await db.resume.update({
      where: { id: existingResume.id },
      data: { content: JSON.stringify(DEMO_RESUME) },
    });
  } else {
    await db.resume.create({
      data: {
        userId: user.id,
        label: 'Master Resume',
        isMaster: true,
        content: JSON.stringify(DEMO_RESUME),
      },
    });
  }

  const existingAgent = await db.agent.findFirst({ where: { userId: user.id } });
  if (!existingAgent) {
    await db.agent.create({
      data: {
        userId: user.id,
        name: 'Senior Data Roles — Toronto & Remote',
        titles: JSON.stringify(['Senior Data Analyst', 'Analytics Engineer', 'Data Scientist']),
        keywords: JSON.stringify(['SQL', 'dbt', 'Python', 'experimentation']),
        excludeKeywords: JSON.stringify(['intern']),
        locations: JSON.stringify(['Toronto', 'Remote']),
        workMode: 'any',
        jobType: 'full_time',
        minSalary: 95000,
        seniority: 'senior',
        // Low enough to surface adjacent roles (analytics engineer, data
        // scientist) alongside exact-title matches.
        minMatchScore: 55,
        autoApply: false,
        autoApplyThreshold: 85,
        scanFrequency: 'daily',
        status: 'active',
      },
    });
  }

  await db.activityEvent.create({
    data: {
      userId: user.id,
      type: 'agent',
      message: 'Welcome to JobPilot AI — your first agent is ready to scan.',
    },
  });

  console.log('  ✓ Demo account: demo@jobpilot.ai / demo1234');
  console.log('Done.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
