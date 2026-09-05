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
import { verifyDocumentLink } from '../src/lib/documents/sign';

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
    assert.equal(doc.info.version, '1.1.0');
    assert.equal(Object.values(doc.paths).reduce((n, m) => n + Object.keys(m).length, 0), 25, 'thirteen 1.0.0 operations plus twelve additive 1.1.0 operations');
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

  it('exactly one operation is public - the device sign-in - and it says so twice (x-scope public, security [])', () => {
    const doc = loadContract();
    const publics = Object.entries(doc.paths).flatMap(([route, methods]) => Object.entries(methods).filter(([, op]) => op['x-scope'] === 'public').map(([m]) => `${m.toUpperCase()} ${route}`));
    assert.deepEqual(publics, ['POST /v1/auth/sessions']);
    assert.deepEqual(doc.paths['/v1/auth/sessions'].post.security, []);
    // No 1.1 operation hands out admin, and nothing in the contract does.
    const scopes = new Set(Object.values(doc.paths).flatMap((m) => Object.values(m).map((op) => op['x-scope'])));
    assert.ok(!scopes.has('admin'));
  });

  it('every object schema is closed: a leaked column fails validation', () => {
    const doc = loadContract();
    const me = { object: 'me', id: 'u', fullName: 'A', email: 'a@x', country: 'CA', city: null, headline: null, applicationMode: 'prepare', createdAt: '2026-09-05T00:00:00Z' };
    assert.equal(validateAgainst('Me', me).ok, true);
    assert.equal(validateAgainst('Me', { ...me, passwordHash: 'leaked' }).ok, false, 'an extra property is refused');
    assert.equal(validateAgainst('ApplicationDetail', { object: 'application', id: 'x', internal: 1 }).ok, false);
    assert.ok(!JSON.stringify(doc.components.schemas).includes('"allOf"'), 'compositions are flattened so they can be closed');
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
const PASSWORD = `correct-horse-${S}`;
const DEVICE = { name: 'Test phone', platform: 'ios' as const };
const A = { id: `api_a_${S}`, email: `api-a-${S}@api.test` };
const B = { id: `api_b_${S}`, email: `api-b-${S}@api.test` };
let db: Db;
let keys: Keys;
let readKey: string;
let writeKey: string;
/** `write` = read + apply:write: what a device key holds (v1.1). */
let fullKey: string;
let otherKey: string;
const ids: Record<string, string> = {};

async function call(handler: Handler, key: string | null, url: string, params: Record<string, string> = {}, method = 'GET', json?: unknown): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (key !== null) headers.authorization = `Bearer ${key}`;
  if (json !== undefined) headers['content-type'] = 'application/json';
  const response = await handler(new Request(`https://api.test${url}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) }), { params: Promise.resolve(params) });
  return { status: response.status, body: await response.json() };
}

/** Assert a response against the schema the contract declares for (method, route, status). */
function conforms(method: string, route: string, result: { status: number; body: unknown }, expected: number): void {
  assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body).slice(0, 200)}`);
  const schema = responseSchemaOf(loadContract(), method, route, expected);
  assert.ok(schema, `${method} ${route} ${expected} declares no schema`);
  const v = validateAgainst(schema, result.body);
  assert.ok(v.ok, `${method} ${route} ${expected} does not match ${schema}: ${v.errors.join('; ')}`);
  datesParse(result.body, `${method} ${route}`);
}

/** Formats are not validated by ajv (no ajv-formats); every *At string must at least parse. */
function datesParse(value: unknown, at: string): void {
  if (Array.isArray(value)) value.forEach((x, i) => datesParse(x, `${at}[${i}]`));
  else if (value && typeof value === 'object') {
    for (const [k, x] of Object.entries(value as Record<string, unknown>)) {
      if (/At$/.test(k) && typeof x === 'string') assert.ok(!Number.isNaN(Date.parse(x)), `${at}.${k} is not a date: ${x}`);
      datesParse(x, `${at}.${k}`);
    }
  }
}

describe('candidate API contract - against the backend', { skip: SKIP }, () => {
  before(async () => {
    process.env.DATABASE_URL = CONNECTION_STRING;
    process.env.JOB_PROVIDER = 'mock';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.test';
    ({ db } = await import('../src/lib/db'));
    keys = await import('../src/lib/integrations/api-keys');
    const { hashPassword } = await import('../src/lib/auth');
    const passwordHash = await hashPassword(PASSWORD);
    for (const u of [A, B]) await db.user.create({ data: { id: u.id, email: u.email, passwordHash, fullName: 'Api Tester', country: 'CA', city: 'Toronto', headline: 'Analyst' } });
    await db.careerEvidence.create({ data: { userId: A.id, kind: 'employment', sourceType: 'manual', claim: 'Senior Data Analyst at Maple Analytics, 2022-03 to present', facts: '{"company":"Maple Analytics"}', status: 'approved', approvedAt: new Date('2026-09-01T00:00:00Z') } });
    const mint = async (userId: string, scopes: string[]) => {
      const g = keys.generateApiKey('test');
      await db.apiKey.create({ data: { userId, name: 'contract', prefix: g.prefix, keyHash: g.keyHash, scopes: JSON.stringify(scopes), environment: 'test', rateLimitPerMinute: 600 } });
      return g.raw;
    };
    readKey = await mint(A.id, ['read']);
    writeKey = await mint(A.id, ['read', 'apply:write']);
    fullKey = await mint(A.id, ['write']);
    otherKey = await mint(B.id, ['write']);

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

  const load = async (file: string) => (await import(`../src/app/(app)/api/v1/${file}/route`)) as { GET?: Handler; POST?: Handler; PUT?: Handler; PATCH?: Handler; DELETE?: Handler };

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

  // --- v1.1: the mobile operations -------------------------------------------------

  it('v1.1 device sign-in: the password mints a device key that works, lists itself as current, signs itself out and is then refused; a wrong password mints nothing', async () => {
    const { resetRateLimits } = await import('../src/lib/rate-limit');
    resetRateLimits();
    const { POST, GET } = await load('auth/sessions');
    const body = { method: 'password', email: A.email, password: PASSWORD, device: DEVICE };
    assert.equal(validateAgainst('DeviceSignIn', body).ok, true, 'the request body the app sends matches the request schema');
    const issued = await call(POST!, null, '/v1/auth/sessions', {}, 'POST', body);
    conforms('post', '/v1/auth/sessions', issued, 201);
    const { token, session } = issued.body as { token: string; session: { id: string; platform: string; expiresAt: string | null } };
    assert.match(token, /^jp_live_/);
    assert.equal(session.platform, 'ios');
    assert.ok(session.expiresAt && new Date(session.expiresAt).getTime() > Date.now() + 80 * 24 * 3600 * 1000, 'expires in ~90 days');
    const row = await db.apiKey.findUniqueOrThrow({ where: { id: session.id } });
    assert.equal(row.kind, 'device');
    assert.deepEqual(JSON.parse(row.scopes), ['write'], 'write = read + apply:write, never admin');
    assert.ok(!JSON.stringify(row).includes(token.slice(-20)), 'the secret is not stored');

    conforms('get', '/v1/me', await call((await load('me')).GET!, token, '/v1/me', {}), 200);
    const devices = await call(GET!, token, '/v1/auth/sessions', {});
    conforms('get', '/v1/auth/sessions', devices, 200);
    const list = (devices.body as { data: { id: string; current: boolean }[] }).data;
    assert.equal(list.find((d) => d.id === session.id)?.current, true);
    assert.ok(list.every((d) => !('keyHash' in d)));

    const wrong = await call(POST!, null, '/v1/auth/sessions', {}, 'POST', { ...body, password: 'nope' });
    conforms('post', '/v1/auth/sessions', wrong, 401);
    assert.equal(await db.apiKey.count({ where: { userId: A.id, kind: 'device', revokedAt: null } }), 1, 'a failed sign-in mints nothing');
    const noProvider = await call(POST!, null, '/v1/auth/sessions', {}, 'POST', { method: 'supabase', accessToken: 'x'.repeat(40), device: DEVICE });
    conforms('post', '/v1/auth/sessions', noProvider, 503);
    assert.equal((noProvider.body as { error: { code: string } }).error.code, 'unavailable');

    const out = await call((await load('auth/sessions/current')).DELETE!, token, '/v1/auth/sessions/current', {}, 'DELETE');
    conforms('delete', '/v1/auth/sessions/current', out, 200);
    conforms('get', '/v1/me', await call((await load('me')).GET!, token, '/v1/me', {}), 401);
    // An integration key cannot be signed out this way.
    conforms('delete', '/v1/auth/sessions/current', await call((await load('auth/sessions/current')).DELETE!, readKey, '/v1/auth/sessions/current', {}, 'DELETE'), 409);
  });

  it('v1.1 devices are revoked by the owner (scoped), by a password change, and never by a stranger', async () => {
    const { resetRateLimits } = await import('../src/lib/rate-limit');
    resetRateLimits();
    const { POST } = await load('auth/sessions');
    const mintDevice = async (name: string) => ((await call(POST!, null, '/v1/auth/sessions', {}, 'POST', { method: 'password', email: A.email, password: PASSWORD, device: { name, platform: 'android' } })).body as { token: string; session: { id: string } });
    const one = await mintDevice('Phone one');
    const two = await mintDevice('Phone two');
    const revoke = (await load('auth/sessions/[sessionId]')).DELETE!;
    // B cannot revoke A's device: 404, and the device still works.
    conforms('delete', '/v1/auth/sessions/{sessionId}', await call(revoke, otherKey, `/v1/auth/sessions/${one.session.id}`, { sessionId: one.session.id }, 'DELETE'), 404);
    conforms('get', '/v1/me', await call((await load('me')).GET!, one.token, '/v1/me', {}), 200);
    // A revokes device one from device two.
    conforms('delete', '/v1/auth/sessions/{sessionId}', await call(revoke, two.token, `/v1/auth/sessions/${one.session.id}`, { sessionId: one.session.id }, 'DELETE'), 200);
    conforms('get', '/v1/me', await call((await load('me')).GET!, one.token, '/v1/me', {}), 401);
    // A password change revokes every device (the password route calls exactly this).
    const { revokeAllDeviceSessions } = await import('../src/lib/integrations/device-sessions');
    assert.equal(await revokeAllDeviceSessions(A.id, 'password_change'), 1);
    conforms('get', '/v1/me', await call((await load('me')).GET!, two.token, '/v1/me', {}), 401);
    const audit = await db.auditLog.findMany({ where: { actorId: A.id, action: { in: ['auth.device.issued', 'auth.device.revoked'] } } });
    assert.ok(audit.length >= 3);
    assert.ok(audit.every((a) => !a.after.includes('jp_live_')), 'no audit row carries a key');
  });

  it('v1.1 PATCH /me edits name, city, headline and mode; the unreachable mode is refused; an empty patch is 400', async () => {
    const { PATCH } = await load('me') as { PATCH: Handler };
    const edited = await call(PATCH, fullKey, '/v1/me', {}, 'PATCH', { headline: 'Lead Analyst', city: null, applicationMode: 'prepare' });
    conforms('patch', '/v1/me', edited, 200);
    assert.deepEqual([(edited.body as { headline: string }).headline, (edited.body as { city: string | null }).city, (edited.body as { applicationMode: string }).applicationMode], ['Lead Analyst', null, 'prepare']);
    conforms('patch', '/v1/me', await call(PATCH, fullKey, '/v1/me', {}, 'PATCH', { applicationMode: 'approved_auto_apply' }), 403);
    conforms('patch', '/v1/me', await call(PATCH, fullKey, '/v1/me', {}, 'PATCH', {}), 400);
    conforms('patch', '/v1/me', await call(PATCH, fullKey, '/v1/me', {}, 'PATCH', { email: 'new@x.test' }), 400);
    conforms('patch', '/v1/me', await call(PATCH, readKey, '/v1/me', {}, 'PATCH', { headline: 'x' }), 403);
    await db.user.update({ where: { id: A.id }, data: { applicationMode: 'review_submit', city: 'Toronto' } });
  });

  it('v1.1 consents: listed with state; marketing can be granted and withdrawn; a required purpose cannot be withdrawn here; an unavailable purpose fails closed', async () => {
    const list = await call((await load('consents')).GET!, readKey, '/v1/consents', {});
    conforms('get', '/v1/consents', list, 200);
    const consents = (list.body as { data: { purpose: string; granted: boolean; available: boolean; required: boolean }[] }).data;
    assert.equal(consents.length, 6);
    assert.equal(consents.find((c) => c.purpose === 'cross_border_ai_processing')?.available, false);
    assert.equal(consents.find((c) => c.purpose === 'terms_of_service')?.required, true);
    const { PUT } = await load('consents/[purpose]') as { PUT: Handler };
    const granted = await call(PUT, fullKey, '/v1/consents/marketing_email', { purpose: 'marketing_email' }, 'PUT', { granted: true });
    conforms('put', '/v1/consents/{purpose}', granted, 200);
    assert.equal((granted.body as { granted: boolean }).granted, true);
    assert.equal(await db.consentRecord.count({ where: { userId: A.id, purpose: 'marketing_email', revokedAt: null } }), 1);
    await call(PUT, fullKey, '/v1/consents/marketing_email', { purpose: 'marketing_email' }, 'PUT', { granted: true });
    assert.equal(await db.consentRecord.count({ where: { userId: A.id, purpose: 'marketing_email', revokedAt: null } }), 1, 'granting twice records once');
    const withdrawn = await call(PUT, fullKey, '/v1/consents/marketing_email', { purpose: 'marketing_email' }, 'PUT', { granted: false });
    conforms('put', '/v1/consents/{purpose}', withdrawn, 200);
    assert.equal((withdrawn.body as { granted: boolean }).granted, false);
    conforms('put', '/v1/consents/{purpose}', await call(PUT, fullKey, '/v1/consents/terms_of_service', { purpose: 'terms_of_service' }, 'PUT', { granted: false }), 409);
    conforms('put', '/v1/consents/{purpose}', await call(PUT, fullKey, '/v1/consents/cross_border_ai_processing', { purpose: 'cross_border_ai_processing' }, 'PUT', { granted: true }), 409);
    assert.equal(await db.consentRecord.count({ where: { userId: A.id, purpose: 'cross_border_ai_processing' } }), 0);
    conforms('put', '/v1/consents/{purpose}', await call(PUT, fullKey, '/v1/consents/telepathy', { purpose: 'telepathy' }, 'PUT', { granted: true }), 404);
  });

  it('v1.1 saved jobs: save is idempotent and scoped to matched postings, shows on the job detail, lists, and unsaves', async () => {
    const { PUT, DELETE } = await load('jobs/[jobId]/saved') as { PUT: Handler; DELETE: Handler };
    const saved = await call(PUT, fullKey, `/v1/jobs/${ids.job}/saved`, { jobId: ids.job }, 'PUT');
    conforms('put', '/v1/jobs/{jobId}/saved', saved, 200);
    conforms('put', '/v1/jobs/{jobId}/saved', await call(PUT, fullKey, `/v1/jobs/${ids.job}/saved`, { jobId: ids.job }, 'PUT'), 200);
    assert.equal(await db.savedJob.count({ where: { userId: A.id } }), 1);
    conforms('put', '/v1/jobs/{jobId}/saved', await call(PUT, otherKey, `/v1/jobs/${ids.job}/saved`, { jobId: ids.job }, 'PUT'), 404);
    const detail = await call((await load('jobs/[jobId]')).GET!, readKey, `/v1/jobs/${ids.job}`, { jobId: ids.job });
    conforms('get', '/v1/jobs/{jobId}', detail, 200);
    assert.equal((detail.body as { saved: boolean }).saved, true);
    const list = await call((await load('saved-jobs')).GET!, readKey, '/v1/saved-jobs', {});
    conforms('get', '/v1/saved-jobs', list, 200);
    assert.equal((list.body as { pagination: { total: number } }).pagination.total, 1);
    assert.equal(((await call((await load('saved-jobs')).GET!, otherKey, '/v1/saved-jobs', {})).body as { pagination: { total: number } }).pagination.total, 0);
    conforms('delete', '/v1/jobs/{jobId}/saved', await call(DELETE, fullKey, `/v1/jobs/${ids.job}/saved`, { jobId: ids.job }, 'DELETE'), 200);
    conforms('delete', '/v1/jobs/{jobId}/saved', await call(DELETE, fullKey, `/v1/jobs/${ids.job}/saved`, { jobId: ids.job }, 'DELETE'), 200);
    assert.equal(await db.savedJob.count({ where: { userId: A.id } }), 0);
  });

  it('v1.1 a document link is a valid signed link bound to the owner, 201, and 404 for a stranger', async () => {
    const doc = await db.documentVersion.findFirstOrThrow({ where: { userId: A.id, applicationId: ids.application } });
    const { POST } = await load(`applications/[applicationId]/documents/[documentId]/link`);
    const params = { applicationId: ids.application, documentId: doc.id };
    const link = await call(POST!, readKey, `/v1/applications/${ids.application}/documents/${doc.id}/link`, params, 'POST');
    conforms('post', '/v1/applications/{applicationId}/documents/{documentId}/link', link, 201);
    const url = new URL((link.body as { url: string }).url);
    assert.equal(url.origin, 'https://app.test', 'the authority is NEXT_PUBLIC_APP_URL, never the request host (https://api.test)');
    assert.equal(verifyDocumentLink({ documentId: doc.id, userId: url.searchParams.get('u') ?? '', expiresAt: Number(url.searchParams.get('exp')), signature: url.searchParams.get('sig') ?? '' }), 'ok');
    assert.equal(url.searchParams.get('u'), A.id);
    conforms('post', '/v1/applications/{applicationId}/documents/{documentId}/link', await call(POST!, otherKey, `/v1/applications/${ids.application}/documents/${doc.id}/link`, params, 'POST'), 404);
  });

  it('v1.1 evidence is the vault read-only: claims, never facts; a stranger sees none; the status filter is enforced', async () => {
    const list = await call((await load('evidence')).GET!, readKey, '/v1/evidence', {});
    conforms('get', '/v1/evidence', list, 200);
    const body = list.body as { data: { claim: string; status: string }[]; pagination: { total: number } };
    assert.equal(body.pagination.total, 1);
    assert.match(body.data[0].claim, /Senior Data Analyst/);
    assert.ok(!JSON.stringify(body).includes('"facts"'));
    assert.equal(((await call((await load('evidence')).GET!, otherKey, '/v1/evidence', {})).body as { pagination: { total: number } }).pagination.total, 0);
    conforms('get', '/v1/evidence', await call((await load('evidence')).GET!, readKey, '/v1/evidence?status=bogus', {}), 400);
    assert.equal(((await call((await load('evidence')).GET!, readKey, '/v1/evidence?status=revoked', {})).body as { pagination: { total: number } }).pagination.total, 0);
  });
});
