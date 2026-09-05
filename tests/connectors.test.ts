/**
 * Stage 05 — the connector contract, run against every adapter (ADR-0008),
 * plus the shared normalisation/validation/routing and the honesty of the
 * Adzuna adapter on a recorded-shape fixture. No database, no network: the
 * Adzuna adapter is fed the fixture through a stubbed fetch.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { connectorContract } from './connector-contract';
import { MockConnector } from '../src/lib/connectors/mock';
import { EmployerConnector, inMemoryCatalogue } from '../src/lib/connectors/employer';
import { AdzunaConnector } from '../src/lib/connectors/adzuna';
import { AdzunaJobProvider } from '../src/lib/providers/jobs/adzuna';
import { normalizePosting, postingHash, validatePosting } from '../src/lib/connectors/base';
import { CONNECTOR_DEFINITIONS } from '../src/lib/connectors/registry';

const FIXTURE = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'adzuna-search-sample.json'), 'utf8')) as { results: unknown[] };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubAdzuna() {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify(FIXTURE), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

describe('connector contract — mock', () => {
  connectorContract('mock', () => new MockConnector());
  // Stage 18: the first-party source over an in-memory catalogue (the suite runs without a database); one open requisition, one on hold.
  const OPEN = { id: 'req_open', title: 'Data Analyst', location: 'Toronto, ON', country: 'CA', workMode: 'hybrid', jobType: 'full_time', description: 'Analyse data with SQL and Python for the reporting team, building dashboards and models.', requiredSkills: '["SQL","Python"]', preferredSkills: '["Excel"]', certificationRequirements: '[]', experienceYearsMin: 2, salaryMin: 80_000, salaryMax: 100_000, salaryCurrency: 'CAD', status: 'open', openedAt: new Date('2026-09-01T00:00:00Z'), createdAt: new Date('2026-08-30T00:00:00Z'), organization: { name: 'Employer E' } };
  const HELD = { ...OPEN, id: 'req_held', title: 'Data Engineer', status: 'on_hold' };
  connectorContract('employer', () => new EmployerConnector(inMemoryCatalogue([OPEN, HELD])));
  it('employer: only an OPEN requisition is discoverable; closure is what the status says; the apply route is this platform', async () => {
    const c = new EmployerConnector(inMemoryCatalogue([OPEN, HELD, { ...OPEN, id: 'req_filled', status: 'filled' }]));
    const found = await c.discover({ titles: ['analyst'], countries: ['CA'], country: 'CA', limit: 10 } as never);
    assert.deepEqual(found.map((p) => p.externalId), ['req_open']);
    assert.equal(found[0]!.company, 'Employer E');
    assert.ok(found[0]!.requirements?.includes('Required: SQL'));
    assert.deepEqual(await c.refresh(['req_open', 'req_held', 'req_filled', 'req_missing']), { req_open: 'active', req_held: 'unknown', req_filled: 'closed', req_missing: 'unknown' });
    assert.equal(c.getApplicationRoute(c.normalize(found[0]!)).vendor, 'jobpilot');
    assert.equal((await c.healthCheck()).detail, '1 open requisition(s)');
  });
});

describe('connector contract — adzuna (recorded-shape fixture)', () => {
  connectorContract('adzuna', () => {
    stubAdzuna();
    return new AdzunaConnector(new AdzunaJobProvider('test-id', 'test-key'));
  });
  it('sends search criteria only — never a candidate identity — and honours the documented parameters', async () => {
    const calls = stubAdzuna();
    const c = new AdzunaConnector(new AdzunaJobProvider('test-id', 'test-key'));
    await c.discover({ titles: ['Data Analyst'], keywords: ['SQL'], locations: ['Toronto'], country: 'CA', jobType: 'contract', minSalary: 60000, limit: 5 });
    assert.ok(calls.length > 0);
    for (const url of calls) {
      const u = new URL(url);
      assert.equal(u.hostname, 'api.adzuna.com');
      assert.equal(u.searchParams.get('what'), 'Data Analyst SQL');
      assert.equal(u.searchParams.get('where'), 'Toronto');
      assert.equal(u.searchParams.get('contract'), '1');
      assert.equal(u.searchParams.get('salary_min'), '60000');
      for (const p of u.searchParams.keys()) assert.ok(!/name|email|user|candidate|resume/i.test(p), `no identity parameter: ${p}`);
    }
  });
  it('is honest about what the API cannot tell: predicted salaries dropped, no by-id fetch, no closure signal', async () => {
    stubAdzuna();
    const c = new AdzunaConnector(new AdzunaJobProvider('test-id', 'test-key'));
    const found = await c.discover({ titles: ['Data Analyst'], locations: [], country: 'CA' });
    assert.equal(found.length, 2, 'the title-less record is skipped');
    const contract = c.normalize(found.find((p) => p.externalId === 'adzuna:4400002')!);
    assert.equal(contract.salaryMin, undefined, 'a predicted band is not the employer\'s statement');
    assert.equal(contract.jobType, 'contract');
    assert.equal(await c.fetch('adzuna:4400001'), null);
    assert.deepEqual(await c.refresh(['adzuna:4400001']), { 'adzuna:4400001': 'unknown' });
    assert.equal(await c.detectClosed('adzuna:4400001'), 'unknown');
  });
  it('reports down, not a throw, when the API fails — and never carries the response body or a credential', async () => {
    const body = 'UPSTREAM-BODY-MARKER-4d2 {"error":"quota","hint":"contact support"}';
    globalThis.fetch = (async () => new Response(body, { status: 503 })) as typeof fetch;
    const c = new AdzunaConnector(new AdzunaJobProvider('test-id', 'test-key'));
    const report = await c.healthCheck();
    assert.equal(report.status, 'down');
    assert.ok(!report.detail.includes('test-key'), 'a credential never appears in a health detail');
    assert.ok(!report.detail.includes('UPSTREAM-BODY-MARKER'), 'a response body never appears in a health detail');
    assert.match(report.detail, /responded 503/);
    // The same on the discovery path, whose error lands in JobSourceRun.error.
    await assert.rejects(() => c.discover({ titles: ['x'], locations: [], country: 'CA' }), (error: Error) => {
      assert.ok(!error.message.includes('UPSTREAM-BODY-MARKER'), 'a response body never appears in a run error');
      assert.ok(!error.message.includes('test-key'));
      return /responded 503/.test(error.message);
    });
  });
});

describe('mock source — a posting hashes the same whichever query found it', () => {
  it('search results, the catalogue and fetch agree on content, so no query writes a spurious snapshot', async () => {
    const c = new MockConnector();
    const byTitle = await c.discover({ titles: ['Data Analyst'], locations: [], country: 'CA', limit: 30 });
    const byOther = await c.discover({ titles: ['Analyst'], locations: ['Toronto'], country: 'CA', limit: 30 });
    const shared = byTitle.filter((p) => byOther.some((q) => q.externalId === p.externalId));
    assert.ok(shared.length >= 2, `queries must overlap to prove anything (${shared.length})`);
    for (const p of shared) {
      const other = byOther.find((q) => q.externalId === p.externalId)!;
      assert.equal(postingHash(c.normalize(p)), postingHash(c.normalize(other)), `${p.externalId} hashes differently across queries`);
      const fetched = await c.fetch(p.externalId);
      assert.ok(fetched);
      assert.equal(postingHash(c.normalize(fetched)), postingHash(c.normalize(p)), `${p.externalId}: fetch disagrees with discover`);
    }
  });
});

describe('connector base — normalisation, validation, hashing', () => {
  const raw = {
    source: 'x', externalId: 7 as unknown as string, title: '  Senior   Analyst ', company: '', location: ' Toronto ', country: 'CA' as const, workMode: 'hybrid' as const, jobType: 'full_time' as const,
    salaryMin: 0, salaryMax: 100000.6, salaryCurrency: '', description: '  body  ', requirements: ['a', 'a', ' '], skills: ['SQL'], applyUrl: ' https://x.test/a ', applyMethod: 'external' as const, postedAt: new Date('2026-08-01T00:00:00Z'),
  };
  it('normalises whitespace, defaults, numbers and lists deterministically', () => {
    const n = normalizePosting(raw);
    assert.equal(n.externalId, '7');
    assert.equal(n.title, 'Senior Analyst');
    assert.equal(n.company, 'Employer not disclosed');
    assert.equal(n.salaryMin, undefined);
    assert.equal(n.salaryMax, 100001);
    assert.equal(n.salaryCurrency, 'CAD');
    assert.deepEqual(n.requirements, ['a']);
    assert.equal(n.applyUrl, 'https://x.test/a');
    assert.equal(n.postedAt, '2026-08-01T00:00:00.000Z');
    assert.ok(validatePosting(n).ok);
  });
  it('the content hash ignores identity and changes with content', () => {
    const a = postingHash(normalizePosting(raw));
    assert.equal(a, postingHash(normalizePosting({ ...raw, externalId: '8' as unknown as string })));
    assert.notEqual(a, postingHash(normalizePosting({ ...raw, description: 'changed' })));
  });
  it('validation names every problem', () => {
    const v = validatePosting({ ...normalizePosting(raw), title: '', applyUrl: 'ftp://x', postedAt: new Date(Date.now() + 7 * 86_400_000).toISOString() });
    assert.deepEqual(v.reasons.sort(), ['apply_url_not_http', 'missing_title', 'posted_at_in_future']);
  });
});

describe('connector register — definitions', () => {
  it('every definition names its class, credentials and a default record; only the mock and the first-party employer source are enabled by default', () => {
    for (const d of CONNECTOR_DEFINITIONS) {
      assert.ok(d.key && d.name && d.kind);
      // Stage 18: employer requisitions are the platform's own rows, not a third party (ADR-0033).
      assert.equal(d.enabledByDefault, d.key === 'mock' || d.key === 'employer');
      if (d.enabledByDefault) assert.ok(d.defaults.legalBasis.length > 0);
    }
    const adzuna = CONNECTOR_DEFINITIONS.find((d) => d.key === 'adzuna')!;
    assert.deepEqual([...adzuna.credentialEnvVars], ['ADZUNA_APP_ID', 'ADZUNA_APP_KEY']);
    assert.equal(adzuna.defaults.legalBasis, '', 'the legal basis is a person\'s record, not a default');
  });
});
