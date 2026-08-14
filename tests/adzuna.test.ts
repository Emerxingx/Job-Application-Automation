import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { AdzunaJobProvider } from '../src/lib/providers/jobs/adzuna';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface StubJob {
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
}

/** Serve a fixed result set and record the URLs the provider requested. */
function stubFetch(results: StubJob[]) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ count: results.length, results }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return calls;
}

function job(overrides: Partial<StubJob> = {}): StubJob {
  return {
    id: '1',
    title: 'Senior Data Analyst',
    description: 'We require 5+ years experience with SQL and Python. Knowledge of dbt is a plus.',
    created: '2026-08-01T10:00:00Z',
    redirect_url: 'https://www.adzuna.ca/land/ad/1',
    company: { display_name: 'Acme Analytics' },
    location: { display_name: 'Toronto, ON' },
    ...overrides,
  };
}

const provider = () => new AdzunaJobProvider('test-id', 'test-key');
const query = { titles: ['Data Analyst'], locations: ['Toronto'], country: 'CA' as const };

describe('AdzunaJobProvider', () => {
  it('requires credentials', () => {
    assert.throws(() => new AdzunaJobProvider('', ''), /ADZUNA_APP_ID/);
  });

  it('maps a posting into the internal shape', async () => {
    stubFetch([job()]);
    const [posting] = await provider().search(query);

    assert.equal(posting.source, 'adzuna');
    assert.equal(posting.externalId, 'adzuna:1');
    assert.equal(posting.title, 'Senior Data Analyst');
    assert.equal(posting.company, 'Acme Analytics');
    assert.equal(posting.location, 'Toronto, ON');
    assert.equal(posting.country, 'CA');
    assert.equal(posting.salaryCurrency, 'CAD');
    assert.equal(posting.applyUrl, 'https://www.adzuna.ca/land/ad/1');
    assert.ok(posting.postedAt instanceof Date);
  });

  it('drops predicted salary bands rather than presenting them as stated', async () => {
    stubFetch([job({ salary_min: 90000, salary_max: 120000, salary_is_predicted: '1' })]);
    const [posting] = await provider().search(query);
    assert.equal(posting.salaryMin, undefined);
    assert.equal(posting.salaryMax, undefined);
  });

  it('keeps salary the employer actually stated', async () => {
    stubFetch([job({ salary_min: 90000, salary_max: 120000, salary_is_predicted: '0' })]);
    const [posting] = await provider().search(query);
    assert.equal(posting.salaryMin, 90000);
    assert.equal(posting.salaryMax, 120000);
  });

  it('infers work mode and job type from the text', async () => {
    stubFetch([job({ description: 'This is a fully remote role.' })]);
    const [remote] = await provider().search(query);
    assert.equal(remote.workMode, 'remote');

    stubFetch([job({ id: '2', description: 'Hybrid, 3 days in office.' })]);
    const [hybrid] = await provider().search(query);
    assert.equal(hybrid.workMode, 'hybrid');

    stubFetch([job({ id: '3', description: 'A 12-month contract position.' })]);
    const [contract] = await provider().search(query);
    assert.equal(contract.jobType, 'contract');

    stubFetch([job({ id: '4', title: 'Data Analyst Intern', description: 'Summer internship.' })]);
    const [intern] = await provider().search(query);
    assert.equal(intern.jobType, 'internship');
  });

  it('infers a NOC code for Canadian postings and omits it for US ones', async () => {
    stubFetch([job({ title: 'Data Scientist' })]);
    const [ca] = await provider().search(query);
    assert.equal(ca.nocCode, '21211');

    stubFetch([job({ title: 'Data Scientist' })]);
    const [us] = await provider().search({ ...query, country: 'US' });
    assert.equal(us.nocCode, undefined);
    assert.equal(us.salaryCurrency, 'USD');
  });

  it('leaves the NOC code unset rather than guessing on an unmapped title', async () => {
    stubFetch([job({ title: 'Chief Vibes Officer' })]);
    const [posting] = await provider().search(query);
    assert.equal(posting.nocCode, undefined);
  });

  it('extracts skills and requirement-shaped sentences', async () => {
    stubFetch([job()]);
    const [posting] = await provider().search(query);
    assert.ok(posting.skills.includes('sql'), `skills were ${JSON.stringify(posting.skills)}`);
    assert.ok(posting.requirements.length > 0);
    assert.ok(posting.requirements.some((r) => /years/i.test(r)));
  });

  it('decodes HTML entities and strips tags from the snippet', async () => {
    stubFetch([job({ description: 'Research &amp; <b>analysis</b> for R&amp;D teams.' })]);
    const [posting] = await provider().search(query);
    assert.ok(!posting.description.includes('&amp;'));
    assert.ok(!posting.description.includes('<b>'));
    assert.match(posting.description, /Research & analysis/);
  });

  it('deduplicates the same posting surfaced by several title queries', async () => {
    stubFetch([job(), job()]);
    const postings = await provider().search({ ...query, titles: ['Data Analyst', 'Analyst'] });
    assert.equal(postings.length, 1);
  });

  it('drops postings matching an excluded keyword', async () => {
    stubFetch([job({ title: 'Senior Data Analyst (Unpaid)' }), job({ id: '9' })]);
    const postings = await provider().search({ ...query, excludeKeywords: ['unpaid'] });
    assert.equal(postings.length, 1);
    assert.equal(postings[0].externalId, 'adzuna:9');
  });

  it('skips records with no title or apply link instead of emitting broken rows', async () => {
    stubFetch([job({ id: 'a', title: undefined }), job({ id: 'b', redirect_url: undefined }), job({ id: 'c' })]);
    const postings = await provider().search(query);
    assert.equal(postings.length, 1);
    assert.equal(postings[0].externalId, 'adzuna:c');
  });

  it('honours the requested limit and returns newest first', async () => {
    stubFetch([
      job({ id: 'old', created: '2026-07-01T00:00:00Z' }),
      job({ id: 'new', created: '2026-08-10T00:00:00Z' }),
    ]);
    const postings = await provider().search({ ...query, limit: 1 });
    assert.equal(postings.length, 1);
    assert.equal(postings[0].externalId, 'adzuna:new');
  });

  it('passes search constraints through to the API', async () => {
    const calls = stubFetch([job()]);
    await provider().search({ ...query, minSalary: 90000, jobType: 'full_time', keywords: ['dbt'] });
    const url = calls[0];
    assert.match(url, /salary_min=90000/);
    assert.match(url, /full_time=1/);
    assert.match(url, /jobs\/ca\/search/);
    assert.match(url, /dbt/);
  });

  it('surfaces an error when every upstream call fails', async () => {
    globalThis.fetch = (async () => new Response('rate limited', { status: 429 })) as typeof fetch;
    await assert.rejects(() => provider().search(query), /Adzuna search failed/);
  });

  it('does not claim to submit applications', async () => {
    const result = await provider().submit();
    assert.equal(result.ok, false);
    assert.match(result.failureReason ?? '', /apply engine/);
  });
});
