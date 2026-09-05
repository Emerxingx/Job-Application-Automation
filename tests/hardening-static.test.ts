/**
 * Stage 23 (ADR-0037) - hardening, statically and purely: the response
 * headers every route carries are the one list `next.config.mjs` ships; the
 * edge gate refuses a cross-site write that carries the session cookie and
 * exposes the health check without a session; an unhandled error is logged
 * through the redactor and the redactor strips what a log must never hold;
 * no secret-shaped string is tracked in the repository and `.env` never
 * will be; the erasure and retention paths exist, are audited, and never
 * touch a statutory table.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { CSP_BASE_DIRECTIVES, SECURITY_HEADERS, contentSecurityPolicy } from '../security-headers.mjs';
import { isCrossSiteWrite, isPublicPath } from '../src/proxy';
import { redact, redactError } from '../src/lib/log';

const root = path.join(__dirname, '..');
const read = (...p: string[]) => readFileSync(path.join(root, ...p), 'utf8');

describe('Stage 23 - security headers', () => {
  it('every route carries the one header list, and the list holds the protections a nonce-less policy can give', () => {
    const config = read('next.config.mjs');
    assert.match(config, /import \{ SECURITY_HEADERS \} from '\.\/security-headers\.mjs'/);
    assert.match(config, /source: '\/\(\.\*\)', headers: SECURITY_HEADERS/);
    const byKey = new Map(SECURITY_HEADERS.map((h) => [h.key, h.value]));
    // Stage 24 (ADR-0038): the policy is per request (a nonce), built by the
    // edge gate from the base directives; it is no longer a static header.
    assert.equal(byKey.get('Content-Security-Policy'), undefined, 'a static header cannot carry a per-request nonce');
    const csp = contentSecurityPolicy('n0nce', false);
    for (const d of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"]) assert.ok(CSP_BASE_DIRECTIVES.includes(d) && csp.includes(d), d);
    assert.match(csp, /script-src 'nonce-n0nce' 'strict-dynamic'/);
    assert.ok(!/unsafe-eval|unsafe-inline/.test(csp), 'production never gets an unsafe source');
    assert.match(contentSecurityPolicy('n0nce', true), /'unsafe-eval'/, 'development needs eval for source maps');
    const proxy = read('src', 'proxy.ts');
    assert.match(proxy, /requestHeaders\.set\('Content-Security-Policy', csp\)/, 'the policy reaches Next on the request so it stamps the nonce');
    assert.equal((proxy.match(/withCsp\(/g) ?? []).length, 5, 'every response the gate returns (next, 403, 401, redirect) carries the policy');
    assert.equal(byKey.get('X-Frame-Options'), 'DENY');
    assert.equal(byKey.get('X-Content-Type-Options'), 'nosniff');
    assert.match(byKey.get('Strict-Transport-Security') ?? '', /max-age=\d{7,}; includeSubDomains/);
    assert.match(byKey.get('Referrer-Policy') ?? '', /strict-origin-when-cross-origin/);
    assert.match(byKey.get('Permissions-Policy') ?? '', /camera=\(\)/);
    assert.equal(new Set(SECURITY_HEADERS.map((h) => h.key)).size, SECURITY_HEADERS.length);
  });
});

describe('Stage 23 - the edge gate: CSRF and the health check', () => {
  const headers = (h: Record<string, string>) => ({ get: (name: string) => h[name.toLowerCase()] ?? null });

  it('a safe method is never cross-site; a bearer-authenticated prefix is never cross-site', () => {
    assert.equal(isCrossSiteWrite('GET', headers({ 'sec-fetch-site': 'cross-site' }), 'app.example', '/api/profile'), false);
    assert.equal(isCrossSiteWrite('HEAD', headers({ origin: 'https://evil.example' }), 'app.example', '/api/profile'), false);
    assert.equal(isCrossSiteWrite('POST', headers({ 'sec-fetch-site': 'cross-site' }), 'app.example', '/api/v1/applications'), false);
    assert.equal(isCrossSiteWrite('POST', headers({ 'sec-fetch-site': 'cross-site' }), 'app.example', '/api/webhooks/stripe'), false);
    assert.equal(isCrossSiteWrite('PATCH', headers({ 'sec-fetch-site': 'cross-site' }), 'app.example', '/api/scim/v2/Users/x'), false);
  });

  it('the browser\'s own fetch metadata decides when present', () => {
    assert.equal(isCrossSiteWrite('POST', headers({ 'sec-fetch-site': 'cross-site' }), 'app.example', '/api/profile'), true);
    assert.equal(isCrossSiteWrite('POST', headers({ 'sec-fetch-site': 'same-origin' }), 'app.example', '/api/profile'), false);
    assert.equal(isCrossSiteWrite('POST', headers({ 'sec-fetch-site': 'same-site' }), 'app.example', '/api/profile'), true, 'a sibling subdomain is another origin (review L7)');
    assert.equal(isCrossSiteWrite('POST', headers({ 'sec-fetch-site': 'none' }), 'app.example', '/api/profile'), false, 'a navigation the user typed');
    assert.equal(isCrossSiteWrite('DELETE', headers({ 'sec-fetch-site': 'cross-site', origin: 'https://app.example' }), 'app.example', '/api/profile'), true, 'fetch metadata outranks a matching Origin');
  });

  it('without fetch metadata, an Origin naming another host is refused and a matching or absent Origin is allowed', () => {
    assert.equal(isCrossSiteWrite('POST', headers({ origin: 'https://evil.example' }), 'app.example', '/api/profile'), true);
    assert.equal(isCrossSiteWrite('POST', headers({ origin: 'https://APP.example' }), 'app.example', '/api/profile'), false);
    assert.equal(isCrossSiteWrite('POST', headers({ origin: 'https://app.example:8443' }), 'app.example', '/api/profile'), true, 'a different port is a different origin');
    assert.equal(isCrossSiteWrite('POST', headers({ origin: 'null' }), 'app.example', '/api/profile'), true, 'an opaque origin is not ours');
    assert.equal(isCrossSiteWrite('POST', headers({}), 'app.example', '/api/profile'), false, 'no header at all: a non-browser client; the cookie is the credential');
    assert.equal(isCrossSiteWrite('POST', headers({ origin: 'https://evil.example' }), null, '/api/profile'), false, 'no Host to compare against: cannot decide, do not refuse');
  });

  it('the proxy applies the check only when the session cookie is present, before the public-path decision', () => {
    const proxy = read('src', 'proxy.ts');
    const check = proxy.indexOf("(request.cookies.get('jobpilot_session') || request.cookies.get('payload-token')) && isCrossSiteWrite(");
    const publicDecision = proxy.indexOf('if (isPublicPath(pathname)) return next();');
    assert.ok(check > 0 && publicDecision > check, 'a cross-site write to a public route (login, signup) is refused too');
    assert.match(proxy, /status: 403/);
  });

  it('the health check is public and nothing else new is', () => {
    assert.equal(isPublicPath('/api/health'), true);
    assert.equal(isPublicPath('/api/healthz'), false);
    const route = read('src', 'app', '(app)', 'api', 'health', 'route.ts');
    assert.match(route, /rateLimit\('health', clientAddress\(request\)/);
    assert.match(route, /rateLimit\('health:all', 'all', GLOBAL_LIMIT\)/, 'a per-instance budget across every address (review M3)');
    assert.match(route, /MEMO_MS/, 'the answer is memoised');
    assert.ok(!/DATABASE_URL|hostname|process\.env|describeDatabaseUrl/.test(route), 'the health body names no host or environment');
    assert.ok(!/detail: `\$\{/.test(route), 'no detail carries a number or a name; fixed words only');
    assert.match(route, /'Cache-Control': 'no-store'/);
  });
});

describe('Stage 23 - log redaction', () => {
  it('strips credentials, tokens, keys, addresses and numbers and keeps the rest of the message', () => {
    assert.equal(redact('connect to postgresql://app:hunter2@db.internal:5432/x failed'), 'connect to postgresql://[redacted]@db.internal:5432/x failed');
    assert.equal(redact('Authorization: Bearer abc.def.ghi-jkl'), 'Authorization: Bearer [redacted]');
    assert.equal(redact('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXNpZ25hdHVyZQ expired'), 'token [redacted-jwt] expired');
    // A short tail: the redactor's rule needs eight characters, a real Stripe key has twenty-four, and a push-protection scanner must not mistake a fixture for a credential.
    assert.equal(redact('key sk_live_0000000000 rejected'), 'key [redacted-key] rejected');
    assert.equal(redact('AKIAIOSFODNN7EXAMPLE'), '[redacted-key]');
    assert.equal(redact('sk-ant-api03-abcdefghijklmnop'), '[redacted-key]');
    assert.equal(redact('jp_live_8f3a0123456789abcdef used'), '[redacted-key] used');
    assert.equal(redact('Unique constraint failed on email: jane.doe@example.com'), 'Unique constraint failed on email: [redacted-email]');
    assert.equal(redact('call +1 (604) 555-0199 now'), 'call [redacted-number] now');
    assert.equal(redact('call (604) 555-0199 or 604-555-0199'), 'call [redacted-number] or [redacted-number]');
    assert.equal(redact('row 42 of Application not found'), 'row 42 of Application not found', 'short numbers and ids survive');
    assert.equal(redact('P2002 on cuid cm1abcd23ef4567890'), 'P2002 on cuid cm1abcd23ef4567890');
    // Review L2: operational identifiers the person on call needs survive.
    assert.equal(redact('invoice INV-2026-000123 and ticket TKT-2026-000123 at 2026-09-05 12:00:00'), 'invoice INV-2026-000123 and ticket TKT-2026-000123 at 2026-09-05 12:00:00');
    // Review M6: a webhook signing secret has no live/test infix; a long hex or base64 blob is a key or a digest.
    assert.equal(redact('whsec_a1b2c3d4e5f6g7h8 rejected'), '[redacted-key] rejected');
    assert.equal(redact('secret 3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a leaked'), 'secret [redacted-hex] leaked');
    assert.equal(redact('key Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1ub3A= leaked'), 'key [redacted-blob] leaked');
    assert.equal(redact('at /home/user/Job-Application-Automation/src/lib/privacy/erasure.ts:12'), 'at /home/user/Job-Application-Automation/src/lib/privacy/erasure.ts:12', 'a path survives');
  });

  it('the redactor never throws and carries a redacted cause (review L3)', () => {
    const hostile = Object.create(null) as object;
    assert.deepEqual(redactError(hostile), { name: 'Error', message: '[unprintable]' });
    const throwing = { [Symbol.toPrimitive]: () => { throw new Error('nope'); } };
    assert.deepEqual(redactError(throwing), { name: 'Error', message: '[unprintable]' });
    const withCause = new Error('outer', { cause: new Error('inner jane@example.com') });
    assert.deepEqual(redactError(withCause).cause, { name: 'Error', message: 'inner [redacted-email]' });
  });

  it('never logs the error object; name, redacted message and redacted stack only', () => {
    const e = new Error('user jane@example.com with Bearer tok.en.value');
    const out = redactError(e);
    assert.equal(out.name, 'Error');
    assert.equal(out.message, 'user [redacted-email] with Bearer [redacted]');
    assert.ok(out.stack && !out.stack.includes('jane@example.com'));
    assert.deepEqual(redactError('plain jane@example.com'), { name: 'Error', message: 'plain [redacted-email]' });
    assert.match(read('src', 'lib', 'api.ts'), /console\.error\('\[api\] unhandled error:', redactError\(error\)\)/);
    assert.ok(!/console\.error\('\[api\] unhandled error:', error\)/.test(read('src', 'lib', 'api.ts')));
  });

  it('no server-side log line carries a raw error object or an unredacted message (review M2)', () => {
    // Every `console.error` / `console.warn` under src whose argument is the
    // caught error itself, or its `.message`, must go through the redactor.
    // Client components (`'use client'`) log to the browser's console and
    // are outside a server log store; they are the only exemption.
    const files = execFileSync('git', ['ls-files', 'src'], { cwd: root, encoding: 'utf8' }).split('\n').filter((f) => /\.tsx?$/.test(f));
    const offenders: string[] = [];
    for (const f of files) {
      const text = read(f);
      if (text.startsWith("'use client'") || f === 'src/lib/log.ts') continue;
      text.split('\n').forEach((line, i) => {
        if (!/console\.(error|warn)\(/.test(line)) return;
        if (/[,(]\s*(error|err|e)\s*\)/.test(line) && !/redactError\((error|err|e)\)/.test(line)) offenders.push(`${f}:${i + 1}`);
        if (/\b(error|err|e)\.message\b/.test(line) && !/redact/.test(line)) offenders.push(`${f}:${i + 1}`);
      });
    }
    assert.deepEqual(offenders, []);
  });
});

describe('Stage 23 - secret hygiene', () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);

  it('no environment file is tracked and .gitignore refuses one', () => {
    assert.ok(!tracked.some((f) => /^\.env(\..+)?$/.test(f) && f !== '.env.example'), 'a .env file is tracked');
    assert.match(read('.gitignore'), /^\.env(\*|\.local|$)/m);
  });

  it('no tracked file carries a secret-shaped value', () => {
    const patterns: [string, RegExp][] = [
      ['stripe key', /\b(sk|rk)_(live|test)_[A-Za-z0-9]{20,}\b/],
      ['aws access key', /\bAKIA(?![0-9A-Z]*EXAMPLE)[0-9A-Z]{16}\b/], // AWS's documentation keys end in EXAMPLE and are the SigV4 test vectors, not secrets
      ['private key block', /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
      ['anthropic key', /\bsk-ant-[A-Za-z0-9\-_]{20,}\b/],
      ['github token', /\b(ghp|gho|ghu|ghs)_[A-Za-z0-9]{30,}\b/],
      ['slack token', /\bxox[abpr]-[A-Za-z0-9-]{20,}\b/],
      // Review L6: only a loopback host, a placeholder host (`<host>`, `$HOST`, `{host}`, `...`) or a placeholder credential is exempt; a real-looking host with a real-looking password is an offender.
      ['connection string with a non-local password', /\b(postgres|postgresql|mysql|redis|mongodb)(\+srv)?:\/\/(?![^\s/:@'"`]+:(postgres|password|pass|secret|changeme|PASSWORD|\.\.\.|\$[A-Z_{]|<|\{)[^\s/@'"`]*@)[^\s/:@'"`]+:[^\s/@'"`]+@(?!(localhost|127\.0\.0\.1|\$|\{|<|\[|\.\.\.))/],
    ];
    // tests/db-url.test.ts holds deliberately fake credentials to prove describeDatabaseUrl redacts them.
    const skip = (f: string) => /^(package-lock\.json|mobile\/package-lock\.json|tests\/db-url\.test\.ts)$/.test(f) || /\.(png|jpg|jpeg|gif|webp|ico|woff2?|pdf|docx)$/.test(f) || f === 'tests/hardening-static.test.ts' || f === 'src/lib/log.ts';
    const offenders: string[] = [];
    for (const f of tracked) {
      if (skip(f)) continue;
      let text: string;
      try {
        text = readFileSync(path.join(root, f), 'utf8');
      } catch {
        continue;
      }
      for (const [name, re] of patterns) if (re.test(text)) offenders.push(`${f}: ${name}`);
    }
    assert.deepEqual(offenders, []);
  });

  it('the example environment carries placeholders only', () => {
    const example = read('.env.example');
    for (const line of example.split('\n')) {
      const m = /^([A-Z0-9_]+)="?([^"]*)"?$/.exec(line.trim());
      if (!m) continue;
      const [, key, value] = m;
      if (/(KEY|SECRET|TOKEN|PASSWORD)/.test(key!) && value) assert.ok(/dev-only|change-me|example|placeholder|^$/i.test(value!), `${key} in .env.example looks like a real value`);
    }
  });
});

describe('Stage 23 - erasure and retention exist, are audited, and keep the statutory tables', () => {
  it('the erasure routine scrubs in place, never deletes the user row, and never touches invoices, payments, placements or audit rows', () => {
    const src = read('src', 'lib', 'privacy', 'erasure.ts');
    assert.match(src, /anonymizedAt/);
    assert.ok(!/\buser\.delete\(/.test(src) && !/\buser\.deleteMany\(/.test(src), 'the user row is scrubbed, not deleted (invoices and placements restrict it)');
    for (const t of ['invoice', 'payment', 'refund', 'creditNote', 'placement', 'placementInvoice', 'consentRecord']) {
      assert.ok(!new RegExp(`\\b(tx|db)\\.${t}\\.(delete|deleteMany|update|updateMany)\\(`).test(src), `${t} is statutory or evidentiary and is never erased`);
    }
    // Audit rows are never deleted; the ONE permitted write replaces the actor's address, IP and user agent on the person's own rows (review H3).
    assert.ok(!/\b(tx|db)\.auditLog\.(delete|deleteMany)\(/.test(src), 'no audit row is ever deleted');
    const auditWrites = src.match(/\b(tx|db)\.auditLog\.(update|updateMany)\([^)]*\)/g) ?? [];
    assert.deepEqual(auditWrites, ["tx.auditLog.updateMany({ where: { actorId: userId }, data: { actorEmail: scrubbedEmail, ip: null, userAgent: null } })"]);
    for (const t of ['applicationQuestion', 'webhookEndpoint', 'outboundEvent', 'apiIdempotencyRecord']) assert.match(src, new RegExp(`tx\\.${t}\\.deleteMany\\(\\{ where: \\{ userId \\} \\}\\)`), `${t} is the person's own data`);
    assert.match(src, /tx\.supportMessage\.updateMany/);
    assert.match(src, /tx\.referral\.updateMany\(\{ where: \{ refereeUserId: userId \}/);
    assert.match(src, /privacy\.erased/);
    assert.match(src, /eraseSelfIdentification\(/);
    assert.match(src, /revokeAllSessions\(/);
    assert.match(src, /revokeAllDeviceSessions\(/);
    assert.match(src, /deletePrefix\(/, 'the person\'s files leave the object store');
  });

  it('the retention sweep never deletes an audit row, a consent record, an invoice or a submitted document, and is itself audited', () => {
    const src = read('src', 'lib', 'privacy', 'retention.ts');
    for (const t of ['auditLog', 'consentRecord', 'invoice', 'payment', 'documentVersion', 'application', 'case', 'placement']) {
      assert.ok(!new RegExp(`\\b(tx|db)\\.${t}\\.(delete|deleteMany)\\(`).test(src), `${t} has no automated deletion in the platform sweep`);
    }
    assert.match(src, /retention\.swept/);
    assert.match(read('package.json'), /"retention:sweep"/);
  });

  it('the account route is wrapped, requires the person themselves, and the settings page offers it', () => {
    const route = read('src', 'app', '(app)', 'api', 'account', 'erasure', 'route.ts');
    assert.match(route, /export const (GET|POST|DELETE) = route\(/);
    assert.match(route, /requireUser\(\)/);
    assert.ok(!/requireStaff|consoleGate/.test(route), 'erasure is the person\'s own right, not a staff action');
    assert.match(read('src', 'app', '(app)', 'dashboard', 'settings', 'page.tsx'), /AccountErasure/);
  });
});
