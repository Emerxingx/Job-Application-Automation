import type { JobSearchQuery, RawJobPosting, SubmissionResult } from '@/lib/types';
import type { JobProvider } from './types';

// A catalogue of realistic Canadian and US postings. Each entry is a template;
// the provider stamps fresh posting dates on every scan so the feed always
// looks live, which is what a real scraper would produce.

interface JobTemplate {
  title: string;
  company: string;
  location: string;
  country: 'CA' | 'US';
  workMode: 'onsite' | 'hybrid' | 'remote';
  jobType: 'full_time' | 'part_time' | 'contract';
  salaryMin: number;
  salaryMax: number;
  currency: string;
  nocCode?: string;
  family: string;
  skills: string[];
  requirements: string[];
  summary: string;
}

const CATALOGUE: JobTemplate[] = [
  {
    title: 'Senior Data Analyst',
    company: 'Shopify',
    location: 'Toronto, ON',
    country: 'CA',
    workMode: 'remote',
    jobType: 'full_time',
    salaryMin: 105000,
    salaryMax: 135000,
    currency: 'CAD',
    nocCode: '21223',
    family: 'data',
    skills: ['SQL', 'Python', 'Tableau', 'dbt', 'Statistics', 'A/B Testing', 'Snowflake'],
    requirements: [
      '5+ years in analytics or business intelligence',
      'Advanced SQL and data modelling with dbt',
      'Experience designing and interpreting A/B tests',
      'Strong stakeholder communication across product and finance',
      'Python (pandas) for analysis and automation',
    ],
    summary:
      'Own analytics for a core commerce surface, partnering with product and finance to turn behavioural data into merchant-facing decisions.',
  },
  {
    title: 'Data Analyst',
    company: 'RBC',
    location: 'Toronto, ON',
    country: 'CA',
    workMode: 'hybrid',
    jobType: 'full_time',
    salaryMin: 78000,
    salaryMax: 98000,
    currency: 'CAD',
    nocCode: '21223',
    family: 'data',
    skills: ['SQL', 'Power BI', 'Excel', 'Python', 'Data Governance'],
    requirements: [
      '3+ years of analytics experience, ideally in financial services',
      'Expert-level SQL against large relational warehouses',
      'Power BI dashboard development and DAX',
      'Understanding of data governance and regulatory reporting',
    ],
    summary:
      'Support retail banking reporting, building governed dashboards and self-serve datasets for a national branch network.',
  },
  {
    title: 'Business Intelligence Analyst',
    company: 'Telus',
    location: 'Vancouver, BC',
    country: 'CA',
    workMode: 'hybrid',
    jobType: 'full_time',
    salaryMin: 85000,
    salaryMax: 110000,
    currency: 'CAD',
    nocCode: '21223',
    family: 'data',
    skills: ['SQL', 'Looker', 'BigQuery', 'Python', 'ETL'],
    requirements: [
      '4+ years building BI solutions',
      'Hands-on with BigQuery and Looker (LookML)',
      'Pipeline development and ETL orchestration',
      'Comfort presenting insights to senior leadership',
    ],
    summary:
      'Build the reporting backbone for the customer experience organization, from pipeline to executive dashboard.',
  },
  {
    title: 'Analytics Engineer',
    company: 'Wealthsimple',
    location: 'Remote — Canada',
    country: 'CA',
    workMode: 'remote',
    jobType: 'full_time',
    salaryMin: 110000,
    salaryMax: 145000,
    currency: 'CAD',
    nocCode: '21211',
    family: 'data',
    skills: ['dbt', 'SQL', 'Snowflake', 'Python', 'Airflow', 'Data Modelling'],
    requirements: [
      'Deep dbt and dimensional modelling experience',
      'Production Airflow or Dagster orchestration',
      'Snowflake performance tuning',
      'Software engineering rigour: testing, code review, CI',
    ],
    summary:
      'Own the transformation layer that every analyst and product team at the company builds on top of.',
  },
  {
    title: 'Senior Software Engineer, Backend',
    company: 'Stripe',
    location: 'Toronto, ON',
    country: 'CA',
    workMode: 'hybrid',
    jobType: 'full_time',
    salaryMin: 150000,
    salaryMax: 195000,
    currency: 'CAD',
    nocCode: '21231',
    family: 'engineering',
    skills: ['TypeScript', 'Node.js', 'PostgreSQL', 'Distributed Systems', 'AWS', 'Kubernetes'],
    requirements: [
      '6+ years building production backend services',
      'Distributed systems and API design at scale',
      'Strong PostgreSQL and data consistency fundamentals',
      'Experience owning services end to end, including on-call',
    ],
    summary:
      'Design and operate the payment infrastructure services that move billions of dollars for businesses worldwide.',
  },
  {
    title: 'Full Stack Developer',
    company: 'Hootsuite',
    location: 'Vancouver, BC',
    country: 'CA',
    workMode: 'remote',
    jobType: 'full_time',
    salaryMin: 100000,
    salaryMax: 130000,
    currency: 'CAD',
    nocCode: '21232',
    family: 'engineering',
    skills: ['React', 'TypeScript', 'Node.js', 'GraphQL', 'AWS', 'CI/CD'],
    requirements: [
      '4+ years across frontend and backend',
      'React with TypeScript in a production codebase',
      'GraphQL API design',
      'Cloud deployment on AWS with automated pipelines',
    ],
    summary:
      'Ship customer-facing features across the stack for a social media management platform used by millions.',
  },
  {
    title: 'Software Engineer II',
    company: 'Microsoft',
    location: 'Seattle, WA',
    country: 'US',
    workMode: 'hybrid',
    jobType: 'full_time',
    salaryMin: 135000,
    salaryMax: 175000,
    currency: 'USD',
    family: 'engineering',
    skills: ['C#', '.NET', 'Azure', 'Distributed Systems', 'SQL Server'],
    requirements: [
      '3+ years professional software development',
      'C# and .NET in cloud services',
      'Azure platform experience',
      'BS in Computer Science or equivalent practical experience',
    ],
    summary:
      'Join a cloud platform team building services that power enterprise workloads across the globe.',
  },
  {
    title: 'Frontend Engineer',
    company: 'Figma',
    location: 'Remote — US',
    country: 'US',
    workMode: 'remote',
    jobType: 'full_time',
    salaryMin: 145000,
    salaryMax: 190000,
    currency: 'USD',
    family: 'engineering',
    skills: ['React', 'TypeScript', 'WebGL', 'Performance', 'CSS'],
    requirements: [
      '5+ years frontend engineering',
      'Deep React and TypeScript expertise',
      'Browser performance profiling and optimization',
      'Eye for interaction detail and design fidelity',
    ],
    summary:
      'Build the interface for a design tool where performance and craft are the product.',
  },
  {
    title: 'Product Manager',
    company: 'Lightspeed Commerce',
    location: 'Montreal, QC',
    country: 'CA',
    workMode: 'hybrid',
    jobType: 'full_time',
    salaryMin: 110000,
    salaryMax: 140000,
    currency: 'CAD',
    nocCode: '10029',
    family: 'product',
    skills: ['Product Strategy', 'Roadmapping', 'SQL', 'User Research', 'Agile', 'Stakeholder Management'],
    requirements: [
      '5+ years in product management for B2B SaaS',
      'Track record shipping revenue-driving features',
      'Comfort with data: writes own SQL for discovery',
      'Bilingual (English/French) considered an asset',
    ],
    summary:
      'Own the merchant payments roadmap, from discovery through launch, for a global commerce platform.',
  },
  {
    title: 'Senior Product Manager',
    company: 'Slack',
    location: 'Remote — Canada',
    country: 'CA',
    workMode: 'remote',
    jobType: 'full_time',
    salaryMin: 140000,
    salaryMax: 180000,
    currency: 'CAD',
    nocCode: '10029',
    family: 'product',
    skills: ['Product Strategy', 'Platform', 'APIs', 'Analytics', 'Go-to-Market'],
    requirements: [
      '7+ years product management, 2+ on platform or API products',
      'Experience with developer-facing products',
      'Strong written communication and executive presence',
      'Data-informed prioritization',
    ],
    summary:
      'Lead the platform surface that thousands of developers build integrations on top of.',
  },
  {
    title: 'Project Manager, IT',
    company: 'Deloitte Canada',
    location: 'Calgary, AB',
    country: 'CA',
    workMode: 'hybrid',
    jobType: 'contract',
    salaryMin: 95000,
    salaryMax: 120000,
    currency: 'CAD',
    nocCode: '20012',
    family: 'product',
    skills: ['PMP', 'Agile', 'Scrum', 'Stakeholder Management', 'Risk Management', 'Jira'],
    requirements: [
      'PMP certification or equivalent',
      '5+ years managing enterprise IT delivery',
      'Agile and waterfall delivery experience',
      'Client-facing consulting background preferred',
    ],
    summary:
      'Lead multi-stream technology transformation programs for enterprise clients across Western Canada.',
  },
  {
    title: 'Marketing Manager',
    company: 'Canada Goose',
    location: 'Toronto, ON',
    country: 'CA',
    workMode: 'onsite',
    jobType: 'full_time',
    salaryMin: 85000,
    salaryMax: 105000,
    currency: 'CAD',
    nocCode: '10022',
    family: 'marketing',
    skills: ['Brand Strategy', 'Campaign Management', 'Google Analytics', 'SEO', 'Content Marketing'],
    requirements: [
      '5+ years in brand or growth marketing',
      'Retail or consumer goods experience',
      'Campaign budget ownership',
      'Analytics fluency for measuring channel performance',
    ],
    summary:
      'Drive integrated campaigns for a globally recognized Canadian brand across retail and digital channels.',
  },
  {
    title: 'Digital Marketing Specialist',
    company: 'Loblaw Digital',
    location: 'Toronto, ON',
    country: 'CA',
    workMode: 'hybrid',
    jobType: 'full_time',
    salaryMin: 65000,
    salaryMax: 82000,
    currency: 'CAD',
    nocCode: '11202',
    family: 'marketing',
    skills: ['SEM', 'Google Ads', 'Meta Ads', 'Google Analytics', 'A/B Testing', 'SQL'],
    requirements: [
      '3+ years running paid digital campaigns',
      'Hands-on Google Ads and Meta Ads management',
      'Performance analysis and reporting',
      'E-commerce background an asset',
    ],
    summary:
      'Own paid acquisition for Canada’s largest online grocery experience.',
  },
  {
    title: 'Registered Nurse — Medical Surgical',
    company: 'Alberta Health Services',
    location: 'Edmonton, AB',
    country: 'CA',
    workMode: 'onsite',
    jobType: 'full_time',
    salaryMin: 78000,
    salaryMax: 102000,
    currency: 'CAD',
    nocCode: '31301',
    family: 'healthcare',
    skills: ['Patient Care', 'BLS', 'Charting', 'Acute Care', 'Care Planning'],
    requirements: [
      'Active RN registration with CARNA',
      'Current BLS certification',
      '2+ years acute care experience preferred',
      'Ability to work rotating shifts',
    ],
    summary:
      'Deliver patient-centred care on a busy medical-surgical unit within a large provincial health network.',
  },
  {
    title: 'Financial Analyst',
    company: 'Air Canada',
    location: 'Montreal, QC',
    country: 'CA',
    workMode: 'hybrid',
    jobType: 'full_time',
    salaryMin: 75000,
    salaryMax: 95000,
    currency: 'CAD',
    nocCode: '11101',
    family: 'finance',
    skills: ['Financial Modelling', 'Excel', 'Forecasting', 'Variance Analysis', 'SAP'],
    requirements: [
      'CPA or CFA candidate preferred',
      '3+ years FP&A experience',
      'Advanced Excel modelling',
      'Bilingual English/French an asset',
    ],
    summary:
      'Support budgeting, forecasting and variance analysis for a major operating division.',
  },
  {
    title: 'DevOps Engineer',
    company: 'Coveo',
    location: 'Quebec City, QC',
    country: 'CA',
    workMode: 'remote',
    jobType: 'full_time',
    salaryMin: 105000,
    salaryMax: 135000,
    currency: 'CAD',
    nocCode: '21233',
    family: 'engineering',
    skills: ['Kubernetes', 'Terraform', 'AWS', 'CI/CD', 'Docker', 'Observability'],
    requirements: [
      '4+ years in DevOps or platform engineering',
      'Production Kubernetes operation',
      'Infrastructure as code with Terraform',
      'Monitoring and incident response practice',
    ],
    summary:
      'Keep a high-traffic AI search platform reliable, observable and fast to deploy.',
  },
  {
    title: 'Machine Learning Engineer',
    company: 'Cohere',
    location: 'Toronto, ON',
    country: 'CA',
    workMode: 'hybrid',
    jobType: 'full_time',
    salaryMin: 140000,
    salaryMax: 190000,
    currency: 'CAD',
    nocCode: '21211',
    family: 'data',
    skills: ['Python', 'PyTorch', 'LLMs', 'Distributed Training', 'MLOps', 'CUDA'],
    requirements: [
      'Strong Python and PyTorch',
      'Experience training or fine-tuning large models',
      'Distributed training on GPU clusters',
      'Publication or open-source contribution a plus',
    ],
    summary:
      'Train and ship large language models used by enterprises in production.',
  },
  {
    title: 'Customer Success Manager',
    company: 'Jobber',
    location: 'Edmonton, AB',
    country: 'CA',
    workMode: 'hybrid',
    jobType: 'full_time',
    salaryMin: 70000,
    salaryMax: 90000,
    currency: 'CAD',
    nocCode: '11202',
    family: 'sales',
    skills: ['Account Management', 'SaaS', 'Onboarding', 'Churn Reduction', 'Salesforce'],
    requirements: [
      '3+ years in customer success at a SaaS company',
      'Track record improving retention and expansion',
      'CRM fluency (Salesforce or HubSpot)',
      'Excellent verbal and written communication',
    ],
    summary:
      'Own a book of small-business accounts, driving adoption, retention and expansion.',
  },
  {
    title: 'Data Scientist',
    company: 'Shopify',
    location: 'Remote — Canada',
    country: 'CA',
    workMode: 'remote',
    jobType: 'full_time',
    salaryMin: 120000,
    salaryMax: 160000,
    currency: 'CAD',
    nocCode: '21211',
    family: 'data',
    skills: ['Python', 'SQL', 'Machine Learning', 'Statistics', 'Experimentation', 'Causal Inference'],
    requirements: [
      '4+ years applying statistics or ML to product problems',
      'Strong experimentation and causal inference background',
      'Production Python',
      'Ability to communicate technical results to non-technical partners',
    ],
    summary:
      'Apply modelling and experimentation to merchant-facing product decisions.',
  },
  {
    title: 'Business Analyst',
    company: 'Scotiabank',
    location: 'Toronto, ON',
    country: 'CA',
    workMode: 'hybrid',
    jobType: 'full_time',
    salaryMin: 72000,
    salaryMax: 92000,
    currency: 'CAD',
    nocCode: '21221',
    family: 'data',
    skills: ['Requirements Gathering', 'SQL', 'Process Mapping', 'Agile', 'Documentation', 'Excel'],
    requirements: [
      '3+ years as a business analyst in financial services',
      'Requirements elicitation and process documentation',
      'Working SQL knowledge',
      'Agile delivery experience',
    ],
    summary:
      'Bridge business stakeholders and delivery teams on core banking modernization initiatives.',
  },
  {
    title: 'UX Designer',
    company: 'Later',
    location: 'Vancouver, BC',
    country: 'CA',
    workMode: 'remote',
    jobType: 'full_time',
    salaryMin: 90000,
    salaryMax: 115000,
    currency: 'CAD',
    nocCode: '21233',
    family: 'design',
    skills: ['Figma', 'User Research', 'Prototyping', 'Design Systems', 'Accessibility'],
    requirements: [
      '4+ years designing digital products',
      'Portfolio showing end-to-end product work',
      'Design system contribution',
      'Research-informed decision making',
    ],
    summary:
      'Shape the end-to-end experience of a social media marketing platform.',
  },
  {
    title: 'Supply Chain Coordinator',
    company: 'Canadian Tire',
    location: 'Winnipeg, MB',
    country: 'CA',
    workMode: 'onsite',
    jobType: 'full_time',
    salaryMin: 60000,
    salaryMax: 75000,
    currency: 'CAD',
    nocCode: '13201',
    family: 'operations',
    skills: ['Inventory Management', 'SAP', 'Excel', 'Logistics', 'Vendor Management'],
    requirements: [
      '2+ years in supply chain or logistics',
      'ERP experience, SAP preferred',
      'Strong Excel and reporting skills',
      'Supply chain diploma or degree',
    ],
    summary:
      'Coordinate inbound freight and inventory flow across a national distribution network.',
  },
];

// Rotating suffixes keep repeated scans from producing identical postings.
const POSTING_VARIANTS = ['', ' (Bilingual)', ' — New Grad Welcome', ' II', ' — Contract to Hire'];

function hash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function buildDescription(t: JobTemplate): string {
  return [
    `About the role`,
    ``,
    t.summary,
    ``,
    `What you'll do`,
    ``,
    `- Partner with cross-functional teams to deliver measurable outcomes`,
    `- Own your area end to end, from problem definition through delivery`,
    `- Communicate progress, risks and results to stakeholders`,
    `- Raise the bar on quality and documentation within the team`,
    ``,
    `What we're looking for`,
    ``,
    ...t.requirements.map((r) => `- ${r}`),
    ``,
    `Core skills`,
    ``,
    t.skills.join(', '),
    ``,
    `What we offer`,
    ``,
    `- Competitive compensation${t.salaryMin ? ` (${t.currency} ${t.salaryMin.toLocaleString()}–${t.salaryMax.toLocaleString()})` : ''}`,
    `- Comprehensive health and dental benefits from day one`,
    `- ${t.workMode === 'remote' ? 'Fully remote work' : t.workMode === 'hybrid' ? 'Flexible hybrid schedule' : 'Collaborative on-site environment'}`,
    `- Annual learning and development budget`,
    ``,
    `${t.company} is an equal opportunity employer committed to building an inclusive workplace.`,
  ].join('\n');
}

/** Score how well a template answers the query — used to order and filter results. */
function relevance(t: JobTemplate, q: JobSearchQuery): number {
  const titles = q.titles.map((s) => s.toLowerCase()).filter(Boolean);
  const keywords = (q.keywords ?? []).map((s) => s.toLowerCase()).filter(Boolean);
  const haystack = `${t.title} ${t.family} ${t.skills.join(' ')} ${t.summary}`.toLowerCase();

  let score = 0;
  for (const title of titles) {
    const titleLc = t.title.toLowerCase();
    if (titleLc === title) score += 100;
    else if (titleLc.includes(title) || title.includes(titleLc)) score += 70;
    else {
      // Partial word overlap — "data analyst" should still surface "data scientist".
      const words = title.split(/\s+/).filter((w) => w.length > 2);
      const hits = words.filter((w) => haystack.includes(w)).length;
      if (words.length) score += Math.round((hits / words.length) * 45);
    }
  }
  for (const kw of keywords) if (haystack.includes(kw)) score += 8;

  return score;
}

export class MockJobProvider implements JobProvider {
  readonly name = 'mock';

  async search(query: JobSearchQuery): Promise<RawJobPosting[]> {
    // Simulate network latency so loading states are exercised in the UI.
    await new Promise((r) => setTimeout(r, 120));

    const excludes = (query.excludeKeywords ?? []).map((s) => s.toLowerCase()).filter(Boolean);
    const locations = (query.locations ?? []).map((s) => s.toLowerCase()).filter(Boolean);

    const scored = CATALOGUE.map((t) => ({ t, score: relevance(t, query) }))
      .filter(({ t, score }) => {
        if (score <= 0) return false;

        if (query.country && t.country !== query.country) return false;
        if (query.workMode && query.workMode !== 'any' && t.workMode !== query.workMode) return false;
        if (query.jobType && query.jobType !== 'any' && t.jobType !== query.jobType) return false;
        if (query.minSalary && t.salaryMax < query.minSalary) return false;

        if (locations.length) {
          const locMatch = locations.some(
            (l) =>
              l === 'anywhere' ||
              l === 'remote' ||
              t.location.toLowerCase().includes(l) ||
              (t.workMode === 'remote' && l.length > 0),
          );
          if (!locMatch) return false;
        }

        if (excludes.length) {
          const hay = `${t.title} ${t.summary} ${t.skills.join(' ')}`.toLowerCase();
          if (excludes.some((e) => hay.includes(e))) return false;
        }

        return true;
      })
      .sort((a, b) => b.score - a.score);

    const limit = query.limit ?? 25;

    return scored.slice(0, limit).map(({ t }) => this.toPosting(t));
  }

  /**
   * Every catalogue entry as a posting, regardless of any query — what the
   * connector uses to answer fetch() and refresh() honestly.
   */
  all(): RawJobPosting[] {
    return CATALOGUE.map((t) => this.toPosting(t));
  }

  /**
   * Posting dates are spread across the last 14 days from the START of the
   * current day, not from the current millisecond, so a posting's content is
   * stable within a day: the pipeline hashes content, and a mock that moved
   * every timestamp on every call would write a new snapshot per scan. The
   * hour-of-day spread is derived from the template itself, never from the
   * posting's position in a result list: the same posting must hash the same
   * whichever query found it, or every agent with a different query would
   * write a spurious "content changed" snapshot.
   */
  private toPosting(t: JobTemplate): RawJobPosting {
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const seed = hash(`${t.company}:${t.title}:${dayStart.toDateString()}`);
    const variant = POSTING_VARIANTS[seed % POSTING_VARIANTS.length];
    const daysAgo = (seed >> 3) % 14;
    const hourOffset = hash(`${t.company}:${t.title}`) % 24;
    const postedAt = new Date(dayStart.getTime() - daysAgo * 86400000 - hourOffset * 3600000);

    return {
      source: 'mock',
      externalId: `mock-${hash(`${t.company}:${t.title}`)}`,
      title: `${t.title}${variant}`,
      company: t.company,
      location: t.location,
      country: t.country,
      workMode: t.workMode,
      jobType: t.jobType,
      salaryMin: t.salaryMin,
      salaryMax: t.salaryMax,
      salaryCurrency: t.currency,
      description: buildDescription(t),
      requirements: t.requirements,
      skills: t.skills,
      nocCode: t.nocCode,
      applyUrl: `https://careers.example.com/${t.company.toLowerCase().replace(/[^a-z]/g, '-')}/${hash(t.title)}`,
      applyMethod: seed % 3 === 0 ? 'ats_form' : 'external',
      postedAt,
    } satisfies RawJobPosting;
  }

  async submit(input: {
    job: { title: string; company: string; applyUrl: string; applyMethod: string };
  }): Promise<SubmissionResult> {
    await new Promise((r) => setTimeout(r, 200));

    // Deterministic outcome so demo runs are reproducible: ~92% success.
    const seed = hash(`${input.job.company}:${input.job.title}`);
    if (seed % 12 === 0) {
      return {
        ok: false,
        failureReason: 'Employer portal requires a manual assessment step — flagged for your review.',
      };
    }

    return { ok: true, confirmation: `JP-${seed.toString(36).toUpperCase().slice(0, 8)}` };
  }
}
