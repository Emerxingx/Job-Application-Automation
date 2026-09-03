/**
 * Stage 14 - the candidate API contract (ADR-0013, ADR-0028).
 *
 * Pure: the published spec is structurally sound; its hash matches the lock
 * (a change is deliberate or it fails); every contract path has a route file
 * and every v1 route file is in the contract; the error envelope schema is
 * the one http.ts emits.
 *
 * Database: a real key with `read` calls every GET handler and every body is
 * validated against the operation's declared schema; ownership (another
 * user's ids are 404); a `read` key is refused apply:write with the envelope;
 * an `apply:write` key confirms a prepared application and the folder comes
 * back valid; the submit route on a non-permitting mode is refused with the
 * envelope; a never-automated question carries no value through the API.
 */
import './helpers/database-env';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { CONTRACT_PATH, contractHash, contractProblems, contractRouteFiles, loadContract, readLock, responseSchemaOf, validateAgainst } from '../src/lib/integrations/contract';

function routeFilesUnder(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeFilesUnder(full, base));
    else if (entry === 'route.ts') out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

describe('candidate API contract - the document', () => {
  it('is structurally sound: 3.1, semver, every operation scoped with a 2xx schema and Error envelopes on every error', () => {
    assert.deepEqual(contractProblems(), []);
    const doc = loadContract();
    assert.equal(doc.info.version, '1.0.0');
    assert.ok(doc.info['x-frozen-on']);
  });

  it('is frozen: the lock holds the hash of the canonical document', () => {
    const lock = readLock();
    const doc = loadContract();
    assert.equal(lock.version, doc.info.version, 'the lock names the frozen version');
    assert.equal(lock.sha256, contractHash(doc), `the contract changed without re-freezing (npm run api:freeze) - ${CONTRACT_PATH}`);
  });

  it('covers exactly the route files under /api/v1, both ways', () => {
    const v1 = path.join(__dirname, '..', 'src', 'app', '(app)', 'api', 'v1');
    assert.deepEqual(contractRouteFiles(), routeFilesUnder(v1));
  });

  it('the Error envelope schema is what http.ts emits', () => {
    const ok = validateAgainst('Error', { error: { type: 'not_found_error', code: 'not_found', message: 'x' } });
    assert.equal(ok.ok, true, ok.errors.join('; '));
    assert.equal(validateAgainst('Error', { error: { type: 'weird', code: 'not_found', message: 'x' } }).ok, false);
    assert.equal(validateAgainst('Error', { error: 'a string' }).ok, false);
  });
});

const CONNECTION_STRING = process.env.TENANCY_TEST_DATABASE_URL;
const REQUIRED = process.env.CI === 'true' || process.env.RLS_TEST_REQUIRED === '1';
if (!CONNECTION_STRING && REQUIRED) throw new Error('TENANCY_TEST_DATABASE_URL is required here (see ci.yml).');
const SKIP = CONNECTION_STRING ? false : 'TENANCY_TEST_DATABASE_URL is not set. REQUIRED in CI.';

type Db = typeof import('../src/lib/db')['db'];
type Keys = typeof import('../src/lib/integrations/api-keys');
type Handler = (request: Request, args?: { params: Promise<Record<string, string>> }) => Promise<Response>;

const S = randomBytes(4).toString('hex');
const A = { id: `api_a_${S}`, email: `api-a-${S}@api.test` };
const B = { id: `api_b_${S}`, email: `api-b-${S}@api.test` };
let db: Db;
let keys: Keys;
let readKey: string;
let writeKey: string;
let otherKey: string;
const ids: Record<string, string> = {};

async function call(handler: Handler, key: string, url: string, params: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; body: unknown }> {
  const response = await handler(new Request(`https://api.test${url}`, { method, headers: { authorization: `Bearer ${key}` } }), { params: Promise.resolve(params) });
  return { status: response.status, body: await response.json() };
}

/** Assert a response against the schema the contract declares for (method, route, status). */
function conforms(method: string, route: string, result: { status: number; body: unknown }, expected: number): void {
  assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body).slice(0, 200)}`);
  const schema = responseSchemaOf(loadContract(), method, route, expected);
  assert.ok(schema, `${method} ${route} ${expected} declares no schema`);
  const v = validateAgainst(schema, result.body);
  assert.ok(v.ok, `${method} ${route} ${expected} does not match ${schema}: ${v.errors.join('; ')}`);
}

describe('candidate API contract - against the backend', { skip: SKIP }, () => {
  before(async () => {
    process.env.DATABASE_URL = CONNECTION_STRING;
    process.env.JOB_PROVIDER = 'mock';
    ({ db } = await import('../src/lib/db'));
    keys = await import('../src/lib/integrations/api-keys');
    for (const u of [A, B]) await db.user.create({ data: { id: u.id, email: u.email, passwordHash: 'x', fullName: 'Api Tester', country: 'CA', city: 'Toronto', headline: 'Analyst' } });
    const mint = async (userId: string, scopes: string[]) => {
      const g = keys.generateApiKey('test');
      await db.apiKey.create({ data: { userId, name: 'contract', prefix: g.prefix, keyHash: g.keyHash, scopes: JSON.stringify(scopes), environment: 'test', rateLimitPerMinute: 600 } });
      return g.raw;
    };
    readKey = await mint(A.id, ['read']);
    writeKey = await mint(A.id, ['read', 'apply:write']);
    otherKey = await mint(B.id, ['read', 'apply:write']);

    const agent = await db.agent.create({ data: { userId: A.id, name: 'Analyst agent', keywords: '["sql"]', locations: '["Toronto"]' } });
    const job = await db.job.create({ data: { source: 'mock', externalId: `api-${S}-1`, title: 'Senior Data Analyst', normalizedTitle: 'senior data analyst', company: 'Maple Analytics', location: 'Toronto, ON', country: 'CA', description: 'Analyse things.', applyUrl: 'https://careers.example.test/apply/1', postedAt: new Date('2026-08-20T00:00:00Z'), skills: '["sql"]', requirements: '["3 years"]' } });
    ids.job = job.id;
    const match = await db.jobMatch.create({ data: { agentId: agent.id, jobId: job.id, matchScore: 82, status: 'new', matchedKeywords: '["sql"]', missingKeywords: '["tableau"]', rationale: 'Strong SQL.', weightVersion: 'builtin:1', pipelineVersion: '2026-09-03.2' } });
    ids.match = match.id;
    await db.matchDimension.create({ data: { jobMatchId: match.id, userId: A.id, dimension: 'skills', score: 90, weight: 0.34, contribution: 30.6, matched: '["sql"]', missing: '[]', evidenceIds: '["ev_1"]', note: 'exact' } });
    await db.eligibilityResult.create({ data: { userId: A.id, jobId: job.id, outcome: 'eligible', rules: '[{"rule":"work_authorization","status":"pass","reason":"You may work in Canada.","hard":true}]', rulesVersion: '2026-09-03.1' } });
    const application = await db.application.create({ data: { userId: A.id, jobId: job.id, agentId: agent.id, status: 'ready_to_submit', matchScore: 82, atsScore: 70, tailoredResume: 'RESUME', coverLetter: 'LETTER', assistedFields: JSON.stringify([{ key: 'email', label: 'Email', value: A.email }, { key: 'resume', label: 'Resume', value: 'RESUME', multiline: true }]), preparedQuestions: JSON.stringify([{ id: 'q1', question: 'Do you have a disability?', category: 'sensitive', policy: 'NEVER_AUTOMATE', decision: 'never', value: 'LEAKED', canonicalKey: null, evidenceIds: [] }, { id: 'q2', question: 'Notice period?', category: 'logistics', policy: 'ASK_IF_CHANGED', decision: 'ask', value: '2 weeks', canonicalKey: 'notice_period', evidenceIds: [] }]), applicationMode: 'review_submit', fieldMappingVersion: 'builtin:1', atsSubmittable: false } });
    ids.application = application.id;
    await db.applicationStatusHistory.create({ data: { userId: A.id, applicationId: application.id, fromStatus: '', toStatus: 'ready_to_submit', actor: 'system', source: 'applicator' } });
    await db.applicationContact.create({ data: { userId: A.id, applicationId: application.id, role: 'recruiter', name: 'Riley', email: 'riley@maple.test', organisation: 'Maple Analytics' } });
    await db.applicationInterview.create({ data: { userId: A.id, applicationId: application.id, kind: 'phone', scheduledAt: new Date('2026-09-10T15:00:00Z') } });
    await db.documentVersion.create({ data: { userId: A.id, applicationId: application.id, scopeKey: application.id, kind: 'resume', format: 'txt', contentHash: 'abc', sizeBytes: 6, storageKey: `api-${S}/resume.txt` } });
    await db.activityEvent.create({ data: { userId: A.id, type: 'apply', message: 'Prepared 1 application for your review.' } });
    await db.integrationEvent.create({ data: { userId: A.id, type: 'INTERVIEW_DETECTED', applicationId: application.id, payload: '{}' } });
  });
  after(async () => {
    await db.auditLog.deleteMany({ where: { actorId: { in: [A.id, B.id] } } });
    await db.user.deleteMany({ where: { id: { in: [A.id, B.id] } } });
    await db.job.deleteMany({ where: { externalId: { startsWith: `api-${S}` } } });
    await db.$disconnect();
  });

  const load = async (file: string) => (await import(`../src/app/(app)/api/v1/${file}/route`)) as { GET?: Handler; POST?: Handler };

  it('every GET in the contract answers with a body that matches its declared schema', async () => {
    const cases: [string, string, Record<string, string>, string][] = [
      ['/v1/me', 'me', {}, '/v1/me'],
      ['/v1/recommendations', 'recommendations', {}, '/v1/recommendations?limit=5'],
      ['/v1/jobs', 'jobs', {}, '/v1/jobs?minScore=50'],
      ['/v1/jobs/{jobId}', 'jobs/[jobId]', { jobId: ids.job }, `/v1/jobs/${ids.job}`],
      ['/v1/matches/{matchId}', 'matches/[matchId]', { matchId: ids.match }, `/v1/matches/${ids.match}`],
      ['/v1/applications', 'applications', {}, '/v1/applications'],
      ['/v1/applications/{applicationId}', 'applications/[applicationId]', { applicationId: ids.application }, `/v1/applications/${ids.application}`],
      ['/v1/interviews', 'interviews', {}, '/v1/interviews'],
      ['/v1/notifications', 'notifications', {}, '/v1/notifications'],
      ['/v1/analytics/summary', 'analytics/summary', {}, '/v1/analytics/summary'],
    ];
    for (const [route, file, params, url] of cases) {
      const { GET } = await load(file);
      assert.ok(GET, `${file} exports GET`);
      conforms('get', route, await call(GET, readKey, url, params), 200);
    }
    const detail = (await call((await load('applications/[applicationId]')).GET!, readKey, `/v1/applications/${ids.application}`, { applicationId: ids.application })).body as { preparedQuestions: { decision: string; value: string }[]; contacts: { name: string }[]; interviews: unknown[]; completeness: { answered: number } };
    assert.equal(detail.preparedQuestions.find((q) => q.decision === 'never')?.value, '', 'a never-automated question carries no value through the API, whatever is stored');
    assert.ok(!JSON.stringify(detail).includes('riley@maple.test'), 'a contact address is not part of the folder contract');
    assert.equal(detail.interviews.length, 1);
    const analysis = (await call((await load('matches/[matchId]')).GET!, readKey, `/v1/matches/${ids.match}`, { matchId: ids.match })).body as { dimensions: { evidenceIds: string[] }[] };
    assert.deepEqual(analysis.dimensions[0].evidenceIds, ['ev_1']);
    const recs = (await call((await load('recommendations')).GET!, readKey, '/v1/recommendations', {})).body as { data: { id: string }[] };
    assert.ok(recs.data.some((j) => j.id === ids.job));
  });

  it('ownership: another key sees 404 envelopes for the same ids, and its lists are empty', async () => {
    conforms('get', '/v1/jobs/{jobId}', await call((await load('jobs/[jobId]')).GET!, otherKey, `/v1/jobs/${ids.job}`, { jobId: ids.job }), 404);
    conforms('get', '/v1/matches/{matchId}', await call((await load('matches/[matchId]')).GET!, otherKey, `/v1/matches/${ids.match}`, { matchId: ids.match }), 404);
    conforms('get', '/v1/applications/{applicationId}', await call((await load('applications/[applicationId]')).GET!, otherKey, `/v1/applications/${ids.application}`, { applicationId: ids.application }), 404);
    const list = (await call((await load('interviews')).GET!, otherKey, '/v1/interviews', {})).body as { data: unknown[]; pagination: { total: number } };
    assert.equal(list.pagination.total, 0);
  });

  it('a read key is refused apply:write with the envelope; an unknown key gets the 401 envelope', async () => {
    const { POST } = await load('applications/[applicationId]/confirm');
    const refused = await call(POST!, readKey, `/v1/applications/${ids.application}/confirm`, { applicationId: ids.application }, 'POST');
    conforms('post', '/v1/applications/{applicationId}/confirm', refused, 403);
    assert.equal((refused.body as { error: { code: string } }).error.code, 'insufficient_scope');
    const anon = await call((await load('me')).GET!, 'jp_test_nope_nope', '/v1/me', {});
    conforms('get', '/v1/me', anon, 401);
  });

  it('submit on a non-permitting mode is refused with the envelope and nothing moves; confirm with apply:write moves the record through the machine and returns a valid folder', async () => {
    await db.user.update({ where: { id: A.id }, data: { applicationMode: 'prepare' } });
    const submit = await call((await load('applications/[applicationId]/submit')).POST!, writeKey, `/v1/applications/${ids.application}/submit`, { applicationId: ids.application }, 'POST');
    conforms('post', '/v1/applications/{applicationId}/submit', submit, 409);
    assert.equal((await db.application.findUniqueOrThrow({ where: { id: ids.application } })).status, 'ready_to_submit');
    await db.user.update({ where: { id: A.id }, data: { applicationMode: 'review_submit' } });
    const notAuthorised = await call((await load('applications/[applicationId]/submit')).POST!, writeKey, `/v1/applications/${ids.application}/submit`, { applicationId: ids.application }, 'POST');
    conforms('post', '/v1/applications/{applicationId}/submit', notAuthorised, 409);

    const confirmed = await call((await load('applications/[applicationId]/confirm')).POST!, writeKey, `/v1/applications/${ids.application}/confirm`, { applicationId: ids.application }, 'POST');
    conforms('post', '/v1/applications/{applicationId}/confirm', confirmed, 200);
    const body = confirmed.body as { status: string; history: { toStatus: string; source: string }[]; documents: { status: string }[] };
    assert.equal(body.status, 'submitted');
    assert.equal(body.history[body.history.length - 1].source, 'confirm');
    assert.equal(body.documents[0].status, 'submitted', 'sealed on confirmation');
    const again = await call((await load('applications/[applicationId]/confirm')).POST!, writeKey, `/v1/applications/${ids.application}/confirm`, { applicationId: ids.application }, 'POST');
    conforms('post', '/v1/applications/{applicationId}/confirm', again, 409);
  });
});
