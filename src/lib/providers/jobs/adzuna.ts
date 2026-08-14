import type { Country, JobSearchQuery, JobType, RawJobPosting, SubmissionResult, WorkMode } from '@/lib/types';
import { extractSkills } from '../ai/keywords';
import type { JobProvider } from './types';

/**
 * Adzuna job source.
 *
 * Adzuna aggregates postings from thousands of boards and employer sites and
 * exposes them under a documented API with a free tier, which makes it a legal
 * and stable way to read the Canadian and US markets — unlike scraping a board
 * whose terms forbid it.
 *
 * Two limits of the upstream data are worth knowing, because they shape what
 * the rest of the app can promise:
 *
 *  - `description` is a snippet (roughly 500 characters), not the full posting.
 *    Match scoring degrades gracefully, but tailoring is sharper when the full
 *    description is fetched from `applyUrl` later.
 *  - There is no NOC code. `nocCode` is inferred from the title where we can,
 *    and left undefined otherwise, rather than guessed.
 *
 * Docs: https://developer.adzuna.com/docs/search
 */

const API_ROOT = 'https://api.adzuna.com/v1/api/jobs';
const RESULTS_PER_PAGE = 50; // Adzuna's maximum
const TIMEOUT_MS = 12_000;

interface AdzunaJob {
  id: string;
  title?: string;
  description?: string;
  created?: string;
  redirect_url?: string;
  salary_min?: number;
  salary_max?: number;
  salary_is_predicted?: string;
  company?: { display_name?: string };
  location?: { display_name?: string; area?: string[] };
  contract_time?: string;
  contract_type?: string;
  category?: { label?: string; tag?: string };
}

interface AdzunaResponse {
  count?: number;
  results?: AdzunaJob[];
}

/** Titles that reliably map to a Canadian NOC code. Extended over time. */
const NOC_BY_TITLE: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bdata\s+analyst\b/i, '21223'],
  [/\bbusiness\s+analyst\b/i, '21221'],
  [/\bdata\s+scientist\b/i, '21211'],
  [/\bdata\s+engineer\b/i, '21231'],
  [/\bmachine\s+learning\b|\bml\s+engineer\b/i, '21211'],
  [/\bsoftware\s+(engineer|developer)\b|\bfull.?stack\b|\bbackend\b|\bfrontend\b/i, '21232'],
  [/\bweb\s+developer\b/i, '21234'],
  [/\bdevops\b|\bsite\s+reliability\b|\bsre\b/i, '21233'],
  [/\bdatabase\s+administrator\b|\bdba\b/i, '21223'],
  [/\bcyber\s*security\b|\binformation\s+security\b/i, '21220'],
  [/\bnetwork\s+(engineer|administrator)\b/i, '21222'],
  [/\bproduct\s+manager\b/i, '10029'],
  [/\bproject\s+manager\b/i, '20012'],
  [/\baccountant\b/i, '11100'],
  [/\bfinancial\s+analyst\b/i, '11101'],
  [/\bmarketing\s+manager\b/i, '10022'],
  [/\bregistered\s+nurse\b/i, '31301'],
  [/\bcivil\s+engineer\b/i, '21300'],
  [/\bmechanical\s+engineer\b/i, '21301'],
  [/\belectrical\s+engineer\b/i, '21310'],
];

function inferNocCode(title: string): string | undefined {
  for (const [pattern, code] of NOC_BY_TITLE) {
    if (pattern.test(title)) return code;
  }
  return undefined;
}

function inferWorkMode(text: string): Exclude<WorkMode, 'any'> {
  if (/\bhybrid\b|\bmode\s+hybride\b/i.test(text)) return 'hybrid';
  if (/\bremote\b|\bwork\s+from\s+home\b|\btélétravail\b|\btelework\b|\bwfh\b/i.test(text)) {
    return 'remote';
  }
  return 'onsite';
}

function inferJobType(job: AdzunaJob, text: string): Exclude<JobType, 'any'> {
  if (/\bintern(ship)?\b|\bco-?op\b|\bstage\b/i.test(text)) return 'internship';
  if (job.contract_type === 'contract' || /\bcontract\b|\bfixed.term\b/i.test(text)) return 'contract';
  if (job.contract_time === 'part_time' || /\bpart.time\b/i.test(text)) return 'part_time';
  return 'full_time';
}

/**
 * Pull requirement-shaped sentences out of the snippet. Adzuna gives no
 * structured requirements, so this is best-effort and intentionally
 * conservative — a wrong requirement is worse than a missing one.
 */
function extractRequirements(description: string): string[] {
  const sentences = description
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+|\s*[•·▪]\s*|\s*\|\s*/)
    .map((s) => s.trim())
    .filter(Boolean);

  const marker =
    /\b(require[sd]?|must have|experience (?:with|in)|proficien\w*|familiar\w*|knowledge of|degree|diploma|certification|years?\b[^.]{0,20}\bexperience|ability to)\b/i;

  return sentences
    .filter((s) => marker.test(s) && s.length >= 20 && s.length <= 240)
    .slice(0, 8);
}

/** Adzuna snippets arrive with entities and trailing ellipses. */
function cleanDescription(raw: string): string {
  return raw
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toCountryCode(country: Country): string {
  return country === 'US' ? 'us' : 'ca';
}

function currencyFor(country: Country): string {
  return country === 'US' ? 'USD' : 'CAD';
}

export class AdzunaJobProvider implements JobProvider {
  readonly name = 'adzuna';

  private readonly appId: string;
  private readonly appKey: string;

  constructor(appId = process.env.ADZUNA_APP_ID, appKey = process.env.ADZUNA_APP_KEY) {
    if (!appId || !appKey) {
      throw new Error('AdzunaJobProvider requires ADZUNA_APP_ID and ADZUNA_APP_KEY.');
    }
    this.appId = appId;
    this.appKey = appKey;
  }

  async search(query: JobSearchQuery): Promise<RawJobPosting[]> {
    const country = query.country ?? 'CA';
    const limit = Math.min(query.limit ?? 25, 100);

    // Adzuna matches one keyword expression per call, so each requested title
    // is its own query. Locations are folded in as `where`, one call per pair,
    // capped so an agent with many titles cannot fan out unboundedly.
    const titles = query.titles.length ? query.titles.slice(0, 5) : [''];
    const locations = query.locations.length ? query.locations.slice(0, 3) : [''];

    const calls: Promise<AdzunaJob[]>[] = [];
    for (const title of titles) {
      for (const location of locations) {
        calls.push(this.fetchPage({ query, country, title, location }));
      }
    }

    const settled = await Promise.allSettled(calls);
    const failures = settled.filter((s) => s.status === 'rejected');
    if (failures.length === settled.length && settled.length > 0) {
      // Every call failed — surface it rather than silently returning nothing.
      const reason = (failures[0] as PromiseRejectedResult).reason;
      throw new Error(`Adzuna search failed: ${reason instanceof Error ? reason.message : reason}`);
    }
    for (const f of failures) {
      console.warn('[adzuna] partial search failure:', (f as PromiseRejectedResult).reason);
    }

    const raw = settled
      .filter((s): s is PromiseFulfilledResult<AdzunaJob[]> => s.status === 'fulfilled')
      .flatMap((s) => s.value);

    // Deduplicate: the same posting surfaces under multiple title queries.
    const seen = new Set<string>();
    const mapped: RawJobPosting[] = [];
    for (const job of raw) {
      if (!job.id || seen.has(job.id)) continue;
      seen.add(job.id);
      const posting = this.map(job, country);
      if (posting) mapped.push(posting);
    }

    const excluded = (query.excludeKeywords ?? []).map((k) => k.toLowerCase()).filter(Boolean);
    const filtered = excluded.length
      ? mapped.filter((p) => {
          const haystack = `${p.title} ${p.company} ${p.description}`.toLowerCase();
          return !excluded.some((term) => haystack.includes(term));
        })
      : mapped;

    filtered.sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime());
    return filtered.slice(0, limit);
  }

  private async fetchPage(input: {
    query: JobSearchQuery;
    country: Country;
    title: string;
    location: string;
  }): Promise<AdzunaJob[]> {
    const { query, country, title, location } = input;

    const params = new URLSearchParams({
      app_id: this.appId,
      app_key: this.appKey,
      results_per_page: String(RESULTS_PER_PAGE),
      'content-type': 'application/json',
      sort_by: 'date',
      max_days_old: '30',
    });

    const what = [title, ...(query.keywords ?? [])].filter(Boolean).join(' ').trim();
    if (what) params.set('what', what);
    if (location) params.set('where', location);
    if (query.minSalary) params.set('salary_min', String(query.minSalary));
    if (query.jobType === 'full_time') params.set('full_time', '1');
    if (query.jobType === 'part_time') params.set('part_time', '1');
    if (query.jobType === 'contract') params.set('contract', '1');
    if (query.excludeKeywords?.length) {
      params.set('what_exclude', query.excludeKeywords.join(' '));
    }

    const url = `${API_ROOT}/${toCountryCode(country)}/search/1?${params.toString()}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
        // Postings change slowly; let Next cache briefly to stay under the
        // free tier's call ceiling when several agents scan at once.
        next: { revalidate: 300 },
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Adzuna responded ${res.status}: ${body.slice(0, 180)}`);
      }

      const data = (await res.json()) as AdzunaResponse;
      return data.results ?? [];
    } finally {
      clearTimeout(timer);
    }
  }

  private map(job: AdzunaJob, country: Country): RawJobPosting | null {
    const title = job.title ? cleanDescription(job.title) : '';
    const applyUrl = job.redirect_url;
    if (!title || !applyUrl) return null;

    const description = cleanDescription(job.description ?? '');
    const haystack = `${title} ${description}`;
    const company = job.company?.display_name?.trim() || 'Employer not disclosed';
    const location =
      job.location?.display_name?.trim() ||
      job.location?.area?.slice(1).reverse().join(', ') ||
      (country === 'US' ? 'United States' : 'Canada');

    // Adzuna returns a predicted salary band on some postings. Publishing a
    // prediction as if the employer stated it would mislead the applicant.
    const predicted = job.salary_is_predicted === '1';

    return {
      source: 'adzuna',
      externalId: `adzuna:${job.id}`,
      title,
      company,
      location,
      country,
      workMode: inferWorkMode(haystack),
      jobType: inferJobType(job, haystack),
      salaryMin: predicted ? undefined : job.salary_min ?? undefined,
      salaryMax: predicted ? undefined : job.salary_max ?? undefined,
      salaryCurrency: currencyFor(country),
      description,
      requirements: extractRequirements(description),
      skills: extractSkills(haystack),
      nocCode: country === 'CA' ? inferNocCode(title) : undefined,
      applyUrl,
      applyMethod: 'external',
      postedAt: job.created ? new Date(job.created) : new Date(),
    };
  }

  /**
   * Adzuna is a discovery source, not a submission channel — every posting
   * redirects to the employer's own portal. Submission is owned by the apply
   * engine (`providers/apply`), which either drives a supported ATS or
   * prepares an assisted application.
   */
  async submit(): Promise<SubmissionResult> {
    return {
      ok: false,
      failureReason:
        'Adzuna postings are applied to through the employer portal — handled by the apply engine.',
    };
  }
}
