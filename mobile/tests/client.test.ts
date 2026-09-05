/**
 * The HTTP client against a fake fetch: URL building, the bearer header,
 * the envelope mapping, the 401 signal, Retry-After, malformed bodies.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiClient, buildUrl, fillPath, type DeviceSignIn } from '../src/api/client';
import { ApiError, MalformedResponseError, NetworkError, describeError } from '../src/api/errors';

type Call = { url: string; init: RequestInit };

function fake(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string>; text?: string; throws?: Error }>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('unexpected call');
    if (next.throws) throw next.throws;
    const text = next.text ?? (next.body === undefined ? '' : JSON.stringify(next.body));
    return new Response(text, { status: next.status, headers: { 'content-type': 'application/json', ...(next.headers ?? {}) } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('fillPath / buildUrl', () => {
  it('substitutes and encodes path parameters, and refuses a hole', () => {
    assert.equal(fillPath('/v1/jobs/{jobId}/saved', { jobId: 'a/b c' }), '/v1/jobs/a%2Fb%20c/saved');
    assert.throws(() => fillPath('/v1/jobs/{jobId}', {}), /Missing path parameter jobId/);
    assert.throws(() => fillPath('/v1/jobs/{jobId}', { jobId: '' }), /Missing path parameter/);
  });
  it('prefixes /api, keeps the host, drops undefined query values', () => {
    assert.equal(buildUrl('https://app.example', '/v1/me'), 'https://app.example/api/v1/me');
    assert.equal(buildUrl('https://app.example/', '/v1/jobs', { limit: 5, offset: undefined, minScore: 50 }), 'https://app.example/api/v1/jobs?limit=5&minScore=50');
  });
});

describe('ApiClient', () => {
  it('sends the bearer key on every call but sign-in, with JSON bodies where there is one', async () => {
    const f = fake([{ status: 200, body: { object: 'me' } }, { status: 201, body: { object: 'device_session_issued', token: 't' } }]);
    const client = new ApiClient({ baseUrl: 'https://app.example', token: () => 'jp_live_x_y', fetchImpl: f.fetchImpl });
    await client.me();
    const signIn: DeviceSignIn = { method: 'password', email: 'a@b.c', password: 'p', device: { name: 'Phone', platform: 'ios' } };
    await client.signIn(signIn);
    const [me, session] = f.calls;
    assert.equal((me!.init.headers as Record<string, string>).Authorization, 'Bearer jp_live_x_y');
    assert.equal(me!.init.method, 'GET');
    assert.equal((session!.init.headers as Record<string, string>).Authorization, undefined, 'sign-in is anonymous');
    assert.equal((session!.init.headers as Record<string, string>)['Content-Type'], 'application/json');
    assert.equal(session!.init.body, JSON.stringify(signIn));
    assert.equal(session!.url, 'https://app.example/api/v1/auth/sessions');
  });

  it('refuses to call without a key (no request is made) and signals the session', async () => {
    const f = fake([]);
    let signalled: ApiError | null = null;
    const client = new ApiClient({ baseUrl: 'https://app.example', token: () => null, fetchImpl: f.fetchImpl, onUnauthorized: (e) => (signalled = e) });
    await assert.rejects(() => client.me(), (e: unknown) => e instanceof ApiError && e.unauthorized);
    assert.equal(f.calls.length, 0);
    assert.ok(signalled);
  });

  it('maps the envelope to ApiError with code, status, param and Retry-After; a 401 signals once', async () => {
    const f = fake([
      { status: 429, body: { error: { type: 'rate_limit_error', code: 'rate_limited', message: 'slow down' } }, headers: { 'Retry-After': '17' } },
      { status: 400, body: { error: { type: 'invalid_request_error', code: 'invalid_request', message: 'bad', param: 'limit' } } },
      { status: 401, body: { error: { type: 'authentication_error', code: 'unauthorized', message: 'Invalid or expired API key.' } } },
      { status: 418, body: { error: { type: 'teapot', code: 'brewing', message: 'x' } } },
    ]);
    const signals: ApiError[] = [];
    const client = new ApiClient({ baseUrl: 'https://app.example', token: () => 'k', fetchImpl: f.fetchImpl, onUnauthorized: (e) => signals.push(e) });
    const limited = await client.me().catch((e: unknown) => e);
    assert.ok(limited instanceof ApiError);
    assert.deepEqual([limited.code, limited.status, limited.retryAfter], ['rate_limited', 429, 17]);
    assert.match(describeError(limited), /17 seconds/);
    const bad = await client.me().catch((e: unknown) => e);
    assert.ok(bad instanceof ApiError && bad.param === 'limit');
    const gone = await client.me().catch((e: unknown) => e);
    assert.ok(gone instanceof ApiError && gone.unauthorized);
    assert.equal(signals.length, 1);
    const odd = await client.me().catch((e: unknown) => e);
    assert.ok(odd instanceof ApiError && odd.code === 'unknown' && odd.status === 418, 'an unknown code is kept as unknown, never guessed');
  });

  it('a network failure or a non-envelope body is a NetworkError, never a credential problem', async () => {
    const f = fake([{ status: 0, throws: new TypeError('Network request failed') }, { status: 502, text: '<html>bad gateway</html>' }, { status: 500, body: { unexpected: true } }]);
    const client = new ApiClient({ baseUrl: 'https://app.example', token: () => 'k', fetchImpl: f.fetchImpl });
    await assert.rejects(() => client.me(), (e: unknown) => e instanceof NetworkError && !(e instanceof MalformedResponseError));
    await assert.rejects(() => client.me(), (e: unknown) => e instanceof MalformedResponseError && e.status === 502);
    await assert.rejects(() => client.me(), (e: unknown) => e instanceof MalformedResponseError && e.status === 500);
    assert.match(describeError(new NetworkError('x')), /offline/);
  });

  it('the write helpers hit the contract paths with the right methods', async () => {
    const f = fake(Array.from({ length: 8 }, () => ({ status: 200, body: {} })));
    const client = new ApiClient({ baseUrl: 'https://app.example', token: () => 'k', fetchImpl: f.fetchImpl });
    await client.confirm('a1');
    await client.submit('a1');
    await client.saveJob('j1');
    await client.unsaveJob('j1');
    await client.setConsent('marketing_email', true);
    await client.updateMe({ headline: 'x' });
    await client.documentLink('a1', 'd1');
    await client.signOut();
    assert.deepEqual(
      f.calls.map((c) => `${c.init.method} ${new URL(c.url).pathname}`),
      ['POST /api/v1/applications/a1/confirm', 'POST /api/v1/applications/a1/submit', 'PUT /api/v1/jobs/j1/saved', 'DELETE /api/v1/jobs/j1/saved', 'PUT /api/v1/consents/marketing_email', 'PATCH /api/v1/me', 'POST /api/v1/applications/a1/documents/d1/link', 'DELETE /api/v1/auth/sessions/current'],
    );
  });
});
