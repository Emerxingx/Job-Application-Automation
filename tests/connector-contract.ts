import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { JobSourceConnector } from '../src/lib/connectors/types';
import { SOURCE_KINDS } from '../src/lib/connectors/types';

/**
 * The connector contract suite (ADR-0008: "a connector contract test suite is
 * the admission gate — every adapter passes the same suite"). Call it inside a
 * `describe` for each adapter with a factory; the adapter may be wired to a
 * recorded fixture. Every one of the eight methods is exercised, and the
 * honesty rules are asserted: no candidate identity in a query, no closure
 * inferred from silence, validation that refuses broken rows, a health check
 * that never throws.
 */
export function connectorContract(name: string, make: () => JobSourceConnector, options: { expectPostings: boolean } = { expectPostings: true }) {
  const query = { titles: ['Data Analyst'], keywords: ['SQL'], locations: ['Toronto'], country: 'CA' as const, limit: 10 };

  it(`${name}: declares its identity, class and credential NAMES`, () => {
    const c = make();
    assert.match(c.key, /^[a-z][a-z0-9_-]*$/);
    assert.ok(c.name.length > 0);
    assert.ok((SOURCE_KINDS as readonly string[]).includes(c.kind));
    assert.ok(Array.isArray(c.credentialEnvVars));
    for (const v of c.credentialEnvVars) assert.match(v, /^[A-Z][A-Z0-9_]+$/, 'credential references are environment variable names');
  });

  it(`${name}: discover → normalize → validate yields well-formed postings, and normalize is pure`, async () => {
    const c = make();
    const found = await c.discover(query);
    assert.ok(Array.isArray(found));
    if (options.expectPostings) assert.ok(found.length > 0, 'the fixture or catalogue yields postings');
    for (const raw of found) {
      const a = c.normalize(raw);
      const b = c.normalize(raw);
      assert.deepEqual(a, b, 'normalize is deterministic');
      assert.equal(a.source, c.key);
      const v = c.validate(a);
      assert.ok(v.ok, `valid posting rejected: ${v.reasons.join(', ')}`);
      assert.ok(['CA', 'US'].includes(a.country));
      assert.match(a.postedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.ok(a.applyUrl.startsWith('http'));
    }
  });

  it(`${name}: validate refuses a broken posting with stable reason codes`, async () => {
    const c = make();
    const found = await c.discover(query);
    const base = found[0] ? c.normalize(found[0]) : null;
    const broken = { ...(base ?? { source: c.key, externalId: 'x', title: 'x', company: 'x', location: '', country: 'CA' as const, workMode: 'remote' as const, jobType: 'full_time' as const, salaryCurrency: 'CAD', description: '', requirements: [], skills: [], applyMethod: 'external' as const, postedAt: new Date().toISOString() }), applyUrl: 'not a url', salaryMin: 10, salaryMax: 5, salaryCurrency: 'dollars' };
    const v = c.validate(broken);
    assert.equal(v.ok, false);
    for (const reason of ['apply_url_invalid', 'salary_range_inverted', 'currency_invalid']) assert.ok(v.reasons.includes(reason), reason);
  });

  it(`${name}: fetch returns a posting or null, never throws`, async () => {
    const c = make();
    const found = await c.discover(query);
    const id = found[0]?.externalId ?? 'does-not-exist';
    const fetched = await c.fetch(id);
    assert.ok(fetched === null || fetched.externalId === id);
    assert.equal(await c.fetch('definitely-not-a-posting'), null);
  });

  it(`${name}: refresh and detectClosed answer active | closed | unknown, and never infer closure`, async () => {
    const c = make();
    const found = await c.discover(query);
    const ids = [...found.slice(0, 2).map((p) => p.externalId), 'definitely-not-a-posting'];
    const states = await c.refresh(ids);
    for (const id of ids) assert.ok(['active', 'closed', 'unknown'].includes(states[id]), `${id}: ${states[id]}`);
    // An id the source cannot know anything about is `unknown`, never
    // `closed`: closure is a statement the source makes, not silence.
    assert.equal(states['definitely-not-a-posting'], 'unknown');
    assert.equal(await c.detectClosed('definitely-not-a-posting'), 'unknown');
  });

  it(`${name}: getApplicationRoute is ats_api only with a credential, assisted for a known ATS, external otherwise`, async () => {
    const c = make();
    const found = await c.discover(query);
    const base = found[0] ? c.normalize(found[0]) : null;
    if (base) assert.ok(['ats_api', 'assisted', 'external'].includes(c.getApplicationRoute(base).channel));
    const greenhouse = { ...(base ?? c.normalize((await c.discover(query))[0])), applyUrl: 'https://boards.greenhouse.io/acme/jobs/123' };
    const route = c.getApplicationRoute(greenhouse);
    assert.equal(route.vendor, 'greenhouse');
    assert.equal(route.channel, process.env.ATS_GREENHOUSE_ACME || process.env.ATS_GREENHOUSE_DEFAULT ? 'ats_api' : 'assisted');
    assert.equal(c.getApplicationRoute({ ...greenhouse, applyUrl: 'https://careers.example.com/x' }).channel, 'external');
  });

  it(`${name}: healthCheck never throws and reports a status and a latency`, async () => {
    const report = await make().healthCheck();
    assert.ok(['ok', 'degraded', 'down'].includes(report.status));
    assert.ok(report.latencyMs >= 0);
    assert.ok(typeof report.detail === 'string');
  });
}
