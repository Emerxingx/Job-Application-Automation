/**
 * Stage 20 (ADR-0035) - the pure and static half of enterprise controls:
 * the admin authorisation matrix (every console route gated, every Stage 20
 * write under step-up), the feature-flag boundary (ADR-0019: the code
 * declares what is flaggable and no flag names a security control), the
 * OIDC pieces against a local key, SCIM parsing, impersonation liveness, the
 * session ceiling, and the public prefixes the new machine endpoints need.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { SignJWT, exportJWK, generateKeyPair, importJWK } from 'jose';
import { authorizationUrl, discover, emailDomain, isEmailDomain, isIssuerUrl, pkceChallenge, pkcePair, verifyIdToken, OidcError } from '../src/lib/sso/oidc';
import { FLAG_REGISTRY, evaluateFlag, isFlagKey, isTierTwoKey } from '../src/lib/admin/feature-flags';
import { auditCsv } from '../src/lib/admin/audit';
import { domainAllowed } from '../src/lib/admin/organizations';
import { isPlatformRole } from '../src/lib/admin/users';
import { parsePatch, parseUserNameFilter, toScimUser, hashScimToken, ScimError } from '../src/lib/scim/service';
import { isImpersonationLive, sessionTtlSeconds, IMPERSONATION_MAX_MINUTES } from '../src/lib/auth';
import { emailDomainAllowed } from '../src/lib/tenancy/organizations';
import { isPublicPath } from '../src/proxy';
import { RLS_TABLES } from '../src/lib/tenancy/rls-tables';
import { encryptClientSecret, decryptClientSecret, ssoKey, SsoKeyMissingError } from '../src/lib/sso/crypto';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* files(full);
    else if (/\.(ts|tsx)$/.test(entry)) yield full;
  }
}

describe('the admin authorisation matrix - every console route is gated, every Stage 20 write is under step-up', () => {
  const consoleApi = path.join(root, 'src/app/(app)/api/console');
  const END_ROUTE = 'src/app/(app)/api/console/impersonation/end/route.ts';

  it('every exported handler under /api/console is wrapped by consoleRoute or governanceRoute and calls requireStaff - except the one documented way out of an impersonation', () => {
    const offenders: string[] = [];
    for (const f of files(consoleApi)) {
      if (!f.endsWith('route.ts')) continue;
      const rel = path.relative(root, f);
      const text = readFileSync(f, 'utf8');
      if (rel === END_ROUTE) {
        assert.match(text, /export async function POST\(/);
        assert.match(text, /currentImpersonation\(\)/);
        assert.ok(!/= (route|consoleRoute|governanceRoute)\(/.test(text), 'the end route is deliberately unwrapped');
        continue;
      }
      for (const m of text.matchAll(/export const (GET|POST|PATCH|PUT|DELETE) = (\w+)\(/g)) {
        if (m[2] !== 'consoleRoute' && m[2] !== 'governanceRoute') offenders.push(`${rel}#${m[1]} uses ${m[2]}`);
      }
      if (!/requireStaff\('(support|billing_ops|admin)'\)/.test(text)) offenders.push(`${rel} never calls requireStaff with a role`);
    }
    assert.deepEqual(offenders, []);
  });

  const MATRIX: Record<string, { reads: 'support' | 'billing_ops' | 'admin'; writes: ('GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE')[] }> = {
    'src/app/(app)/api/console/organizations/route.ts': { reads: 'support', writes: ['POST'] },
    'src/app/(app)/api/console/organizations/[id]/route.ts': { reads: 'support', writes: ['PATCH'] },
    'src/app/(app)/api/console/organizations/[id]/sso/route.ts': { reads: 'admin', writes: ['PUT'] },
    'src/app/(app)/api/console/organizations/[id]/scim-tokens/route.ts': { reads: 'admin', writes: ['POST', 'DELETE'] },
    'src/app/(app)/api/console/users/route.ts': { reads: 'support', writes: ['PATCH'] },
    'src/app/(app)/api/console/flags/route.ts': { reads: 'support', writes: ['PUT'] },
    'src/app/(app)/api/console/impersonation/route.ts': { reads: 'admin', writes: ['POST'] },
    'src/app/(app)/api/console/audit/export/route.ts': { reads: 'admin', writes: [] },
  };
  it('the Stage 20 matrix: reads at the stated rank, every write admin + step-up, in the code as documented', () => {
    for (const [rel, row] of Object.entries(MATRIX)) {
      const text = read(rel);
      assert.match(text, new RegExp(`requireStaff\\('${row.reads}'\\)`), `${rel} reads at ${row.reads}`);
      for (const method of row.writes) {
        const body = text.slice(text.indexOf(`export const ${method} =`));
        const end = body.search(/\nexport const (GET|POST|PATCH|PUT|DELETE) =/);
        const handler = end > 0 ? body.slice(0, end) : body;
        assert.match(handler, /requireStaff\('admin'\)/, `${rel}#${method} is admin`);
        assert.match(handler, /await requireStepUp\(staff, body\.currentPassword, requestMeta\(request\)\)/, `${rel}#${method} is under step-up`);
        assert.ok(handler.indexOf("requireStaff('admin')") < handler.indexOf('requireStepUp('), `${rel}#${method}: the role check precedes step-up`);
      }
    }
  });

  it('the console map offers the new pages at the rank the pages gate on', () => {
    const shell = read('src/app/(app)/console/console-shell.tsx');
    for (const [href, role] of [['/console/organizations', 'support'], ['/console/users', 'support'], ['/console/flags', 'support'], ['/console/audit', 'admin']] as const) {
      assert.match(shell, new RegExp(`href: '${href.replace(/\//g, '\\/')}'[^\\n]*minRole: '${role}'`));
      const page = read(`src/app/(app)/console${href.replace('/console', '')}/page.tsx`);
      assert.match(page, new RegExp(`consoleGate\\('${role}'\\)`));
    }
    assert.match(read('src/app/(app)/console/organizations/[id]/page.tsx'), /consoleGate\('support'\)/);
  });
});

describe('feature flags - ADR-0019: the code declares what is flaggable, and no flag names a security control', () => {
  it('every declared flag is read where it says, passes the Tier-2 filter, and is a dotted key', () => {
    for (const [key, d] of Object.entries(FLAG_REGISTRY)) {
      assert.ok(!isTierTwoKey(key), `${key} names a security control`);
      assert.match(key, /^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/);
      assert.ok(existsSync(path.join(root, d.readBy)), `${key}: ${d.readBy} exists`);
      assert.ok(read(d.readBy).includes(`isFlagEnabled('${key}'`), `${key} is read in ${d.readBy}`);
    }
  });
  it('a key that would name a security control is refused; an undeclared key is not a flag', () => {
    for (const k of ['auth.session_bypass', 'rls.disable', 'consent.skip', 'apply_mode.auto_apply', 'residency.override', 'encryption.off', 'audit_log.mute', 'permission.widen', 'sso.require', 'scim.token.static', 'tenant.isolation_off', 'policy.ignore']) {
      assert.ok(isTierTwoKey(k), `${k} is Tier 2`);
      assert.ok(!isFlagKey(k));
    }
    assert.ok(!isFlagKey('dashboard.new_thing'), 'undeclared');
    assert.ok(isFlagKey('console.audit_export'));
  });
  it('evaluation is deterministic: off is off; 100% is everyone; an allow-listed account is in at 0%; the same account gets the same answer', () => {
    assert.equal(evaluateFlag({ enabled: false, rolloutPercent: 100, allowlist: '[]' }, 'k', 'u'), false);
    assert.equal(evaluateFlag({ enabled: true, rolloutPercent: 100, allowlist: '[]' }, 'k', null), true);
    assert.equal(evaluateFlag({ enabled: true, rolloutPercent: 50, allowlist: '[]' }, 'k', null), false, 'anonymous is only in at 100%');
    assert.equal(evaluateFlag({ enabled: true, rolloutPercent: 0, allowlist: '["u"]' }, 'k', 'u'), true);
    assert.equal(evaluateFlag({ enabled: true, rolloutPercent: 0, allowlist: 'not json' }, 'k', 'u'), false);
    const ins = new Set<string>();
    let on = 0;
    for (let i = 0; i < 400; i++) {
      const a = evaluateFlag({ enabled: true, rolloutPercent: 50, allowlist: '[]' }, 'k', `user-${i}`);
      const b = evaluateFlag({ enabled: true, rolloutPercent: 50, allowlist: '[]' }, 'k', `user-${i}`);
      assert.equal(a, b);
      if (a) {
        on += 1;
        ins.add(`user-${i}`);
      }
    }
    assert.ok(on > 120 && on < 280, `roughly half (${on}/400)`);
    assert.ok(ins.size === on);
  });
  it('no security module reads a flag', () => {
    for (const dir of ['src/lib/auth.ts', 'src/lib/auth-policy.ts', 'src/lib/tenancy', 'src/lib/consent.ts', 'src/lib/apply/modes.ts', 'src/lib/sensitive', 'src/lib/crm/auth.ts', 'src/lib/crm/step-up.ts', 'src/proxy.ts', 'src/lib/security-audit.ts', 'src/lib/sso', 'src/lib/scim']) {
      const full = path.join(root, dir);
      const list = statSync(full).isDirectory() ? [...files(full)] : [full];
      for (const f of list) assert.ok(!/isFlagEnabled|featureFlag\./.test(readFileSync(f, 'utf8')), `${path.relative(root, f)} reads a flag`);
    }
  });
});

describe('OIDC - PKCE, discovery, the authorization request and ID-token verification, against a local key', () => {
  it('PKCE: a 64-character URL-safe verifier and its S256 challenge; issuer URLs are https (or loopback http) without query or fragment', () => {
    const { verifier, challenge } = pkcePair();
    assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
    assert.equal(challenge, pkceChallenge(verifier));
    assert.equal(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', 'RFC 7636 appendix B');
    assert.ok(isIssuerUrl('https://login.example.com/tenant') && isIssuerUrl('http://127.0.0.1:9/x'));
    assert.ok(!isIssuerUrl('http://idp.example.com') && !isIssuerUrl('https://a.b/?x=1') && !isIssuerUrl('ftp://a.b') && !isIssuerUrl('nope'));
    assert.equal(emailDomain('Person@Acme.TEST'), 'acme.test');
    assert.ok(isEmailDomain('acme.test') && isEmailDomain('sub.acme.co.uk') && !isEmailDomain('acme') && !isEmailDomain('-a.test') && !isEmailDomain('a b.test'));
  });

  it('discovery refuses a document that names a different issuer or lacks an endpoint, and never trusts a non-JSON answer', async () => {
    const good = { issuer: 'https://idp.test', authorization_endpoint: 'https://idp.test/a', token_endpoint: 'https://idp.test/t', jwks_uri: 'https://idp.test/j' };
    const fetchWith = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    assert.deepEqual(await discover('https://idp.test', fetchWith(good)), good);
    await assert.rejects(discover('https://idp.test', fetchWith({ ...good, issuer: 'https://evil.test' })), (e: unknown) => e instanceof OidcError && /different issuer/.test(e.message));
    await assert.rejects(discover('https://idp.test', fetchWith({ issuer: 'https://idp.test', token_endpoint: 'https://idp.test/t', jwks_uri: 'https://idp.test/j' })), /lacks authorization_endpoint/);
    await assert.rejects(discover('https://idp.test', fetchWith({ ...good, code_challenge_methods_supported: ['plain'] })), /PKCE S256/);
    await assert.rejects(discover('https://idp.test', fetchWith({}, 500)), /Discovery failed/);
    await assert.rejects(discover('not a url', fetchWith(good)), /not a valid URL/);
  });

  it('the authorization request carries code + S256 + state + nonce + the redirect; the ID token verifies only with the right key, issuer, audience and nonce, and a verified email', async () => {
    const disc = { issuer: 'https://idp.test', authorization_endpoint: 'https://idp.test/authorize', token_endpoint: 'https://idp.test/token', jwks_uri: 'https://idp.test/jwks' };
    const url = new URL(authorizationUrl(disc, { clientId: 'cid', redirectUri: 'https://app.test/cb', state: 'st', nonce: 'nn', codeChallenge: 'cc', loginHint: 'a@b.test' }));
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('scope'), 'openid email profile');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://app.test/cb');
    assert.equal(url.searchParams.get('nonce'), 'nn');

    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const other = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    const getKey = async () => importJWK(jwk, 'RS256');
    const mint = (claims: Record<string, unknown>, key = privateKey) => new SignJWT({ email: 'Person@Acme.test', email_verified: true, nonce: 'nn', name: 'Pat Person', ...claims }).setProtectedHeader({ alg: 'RS256' }).setIssuer('https://idp.test').setAudience('cid').setSubject('sub-1').setIssuedAt().setExpirationTime('5m').sign(key);
    const ok = await verifyIdToken(await mint({}), { issuer: 'https://idp.test', clientId: 'cid', nonce: 'nn', getKey });
    assert.deepEqual(ok, { subject: 'sub-1', email: 'person@acme.test', emailVerified: true, name: 'Pat Person' });
    await assert.rejects(verifyIdToken(await mint({}, other.privateKey), { issuer: 'https://idp.test', clientId: 'cid', nonce: 'nn', getKey }), /did not verify/);
    await assert.rejects(verifyIdToken(await mint({}), { issuer: 'https://idp.test', clientId: 'other', nonce: 'nn', getKey }), /did not verify/);
    await assert.rejects(verifyIdToken(await mint({}), { issuer: 'https://evil.test', clientId: 'cid', nonce: 'nn', getKey }), /did not verify/);
    await assert.rejects(verifyIdToken(await mint({}), { issuer: 'https://idp.test', clientId: 'cid', nonce: 'other', getKey }), /nonce/);
    await assert.rejects(verifyIdToken(await mint({ email_verified: false }), { issuer: 'https://idp.test', clientId: 'cid', nonce: 'nn', getKey }), /not verified that email/);
    await assert.rejects(verifyIdToken(await mint({ email: undefined }), { issuer: 'https://idp.test', clientId: 'cid', nonce: 'nn', getKey }), /did not release an email/);
  });

  it('the client secret is AES-256-GCM under SSO_ENCRYPTION_KEY - a separate key from the mailbox one - and a missing key fails closed', () => {
    const key = Buffer.alloc(32, 7);
    const enc = encryptClientSecret('s3cret', key);
    assert.notEqual(enc.ciphertext, 's3cret');
    assert.equal(decryptClientSecret(enc, key), 's3cret');
    assert.throws(() => decryptClientSecret({ ...enc, tag: (enc.tag[0] === 'A' ? 'B' : 'A') + enc.tag.slice(1) }, key), 'a tampered tag fails');
    assert.throws(() => encryptClientSecret('x', null), SsoKeyMissingError);
    assert.equal(ssoKey({}), null);
    assert.equal(ssoKey({ SSO_ENCRYPTION_KEY: 'short' }), null);
    assert.equal(ssoKey({ SSO_ENCRYPTION_KEY: key.toString('base64') })?.length, 32);
    const crypto = read('src/lib/sso/crypto.ts');
    assert.ok(!/MAILBOX_ENCRYPTION_KEY/.test(crypto) && /SSO_ENCRYPTION_KEY/.test(crypto));
  });

  it('the service never returns a secret, and only the sign-in completion decrypts it', () => {
    const service = read('src/lib/sso/service.ts');
    const describe = service.slice(service.indexOf('function describeConnection'), service.indexOf('export async function describeSsoConnection'));
    assert.ok(!/clientSecret|Ciphertext|Iv\b|Tag\b/.test(describe), 'describeConnection carries no secret material');
    assert.equal((service.match(/decryptClientSecret\(/g) ?? []).length, 1);
    assert.ok(service.indexOf('decryptClientSecret(') > service.indexOf('export async function completeSsoSignIn'));
    for (const rel of ['src/app/(app)/api/console/organizations/[id]/sso/route.ts', 'src/app/(app)/console/organizations/[id]/page.tsx']) assert.ok(!/decryptClientSecret|clientSecretCiphertext/.test(read(rel)), `${rel} never touches the secret`);
  });
});

describe('SCIM - the Users subset, parsed strictly', () => {
  it('PatchOp: replace/add on active and name.formatted; anything else is refused, not ignored', () => {
    assert.deepEqual(parsePatch({ schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', path: 'active', value: false }] }), { active: false });
    assert.deepEqual(parsePatch({ schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'Replace', path: 'active', value: 'True' }, { op: 'add', path: 'name.formatted', value: 'New Name' }] }), { active: true, formatted: 'New Name' });
    assert.deepEqual(parsePatch({ schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', value: { active: false, name: { formatted: 'N' } } }] }), { active: false, formatted: 'N' });
    assert.throws(() => parsePatch({ schemas: [], Operations: [{ op: 'replace', path: 'active', value: false }] }), (e: unknown) => e instanceof ScimError && e.scimType === 'invalidSyntax');
    assert.throws(() => parsePatch({ schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'remove', path: 'active' }] }), /not supported/);
    assert.throws(() => parsePatch({ schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', path: 'userName', value: 'x@y.test' }] }), (e: unknown) => e instanceof ScimError && e.scimType === 'invalidPath');
    assert.throws(() => parsePatch({ schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', path: 'active', value: 'yes' }] }), /boolean/);
  });
  it('the only filter is userName eq; an erased member is inactive with no address; a token digest is SHA-256', () => {
    assert.equal(parseUserNameFilter(null), null);
    assert.equal(parseUserNameFilter('userName eq "A@B.test"'), 'a@b.test');
    assert.throws(() => parseUserNameFilter('emails.value co "x"'), (e: unknown) => e instanceof ScimError && e.scimType === 'invalidFilter');
    const now = new Date();
    const u = toScimUser({ userId: 'u1', acceptedAt: now, removedAt: null, createdAt: now, updatedAt: now, user: { email: 'p@acme.test', fullName: 'Pat', anonymizedAt: now, createdAt: now } }, 'https://app.test/api/scim/v2');
    assert.equal(u.active, false);
    assert.deepEqual(u.emails, []);
    assert.equal(u.userName, 'erased-u1');
    assert.equal(u.meta.location, 'https://app.test/api/scim/v2/Users/u1');
    assert.match(hashScimToken('x'), /^[0-9a-f]{64}$/);
  });
  it('the SCIM routes are not route(): a machine with a token gets SCIM errors, not the cookie envelope; and /api/scim and /api/auth/sso are public at the edge (segment-aware)', () => {
    for (const f of files(path.join(root, 'src/app/(app)/api/scim'))) {
      const text = readFileSync(f, 'utf8');
      assert.match(text, /scimRoute\(/);
      assert.ok(!/\broute\(|requireUser|requireTenant/.test(text), `${path.relative(root, f)} is machine-only`);
    }
    for (const p of ['/api/scim/v2/Users', '/api/scim/v2/Users/abc', '/api/auth/sso/start', '/api/auth/sso/callback']) assert.ok(isPublicPath(p), p);
    for (const p of ['/api/scimx', '/api/auth/ssox', '/api/console/users']) assert.ok(!isPublicPath(p), p);
    assert.equal(RLS_TABLES.SsoConnection?.kind, 'system');
    assert.equal(RLS_TABLES.ScimToken?.kind, 'system');
  });
});

describe('impersonation, the session ceiling, the domain policy and the CSV', () => {
  const claims = { impersonationId: 'i1', userId: 'target', staffId: 'staff', staffSessionId: 's1' };
  const row = (over: Partial<{ userId: string; staffId: string; readOnly: boolean; startedAt: Date; endedAt: Date | null }> = {}) => ({ userId: 'target', staffId: 'staff', readOnly: true, startedAt: new Date(Date.now() - 60_000), endedAt: null, ...over });
  it('an impersonation is live only while unended, inside its window, read-only, for the row it names, and while the staff session is live', () => {
    assert.equal(isImpersonationLive(row(), claims, true), true);
    assert.equal(isImpersonationLive(null, claims, true), false);
    assert.equal(isImpersonationLive(row({ endedAt: new Date() }), claims, true), false);
    assert.equal(isImpersonationLive(row({ startedAt: new Date(Date.now() - (IMPERSONATION_MAX_MINUTES + 1) * 60_000) }), claims, true), false);
    assert.equal(isImpersonationLive(row({ readOnly: false }), claims, true), false);
    assert.equal(isImpersonationLive(row({ userId: 'someone-else' }), claims, true), false);
    assert.equal(isImpersonationLive(row({ staffId: 'other-staff' }), claims, true), false);
    assert.equal(isImpersonationLive(row(), claims, false), false, 'revoking the staff session ends it');
    assert.equal(IMPERSONATION_MAX_MINUTES, 60);
  });
  it('route() refuses every non-GET under an impersonation, before the handler runs; the ending route is the one unwrapped write', () => {
    const api = read('src/lib/api.ts');
    assert.match(api, /const READ_METHODS = new Set\(\['GET', 'HEAD', 'OPTIONS'\]\)/);
    assert.match(api, /if \(request instanceof Request && !READ_METHODS\.has\(request\.method\) && \(await currentImpersonation\(\)\)\) \{\s*return fail\('This is a read-only support session/);
    assert.ok(api.indexOf('await currentImpersonation()') < api.indexOf('return await handler(...args)'));
    const auth = read('src/lib/auth.ts');
    assert.ok(auth.indexOf('const impersonation = await currentImpersonation();') < auth.indexOf('const claims = await readCookieClaims();\n  if (!claims) return null;\n\n  const session'), 'getSessionUserId answers with the target first');
    assert.ok(!/method: 'staff_impersonation'/.test(auth) && !/staff_impersonation/.test(read('src/lib/admin/impersonation.ts')), 'no Session row is ever issued for the target');
  });
  it('the session ceiling shortens and never lengthens; the domain policy is an allow-list or nothing; the platform roles are member plus the staff ranks', () => {
    const month = 30 * 24 * 3600;
    assert.equal(sessionTtlSeconds(null), month);
    assert.equal(sessionTtlSeconds(undefined), month);
    assert.equal(sessionTtlSeconds(8), 8 * 3600);
    assert.equal(sessionTtlSeconds(10_000), month);
    assert.equal(sessionTtlSeconds(0), month);
    assert.ok(emailDomainAllowed('[]', 'a@anything.test') && emailDomainAllowed('["acme.test"]', 'A@ACME.test') && !emailDomainAllowed('["acme.test"]', 'a@other.test') && !emailDomainAllowed('["acme.test"]', 'no-at') && emailDomainAllowed('not json', 'a@b.test'));
    assert.ok(domainAllowed([], 'x@y.test') && domainAllowed(['y.test'], 'x@y.test') && !domainAllowed(['y.test'], 'x@z.test'));
    assert.ok(isPlatformRole('member') && isPlatformRole('admin') && isPlatformRole('billing_ops') && !isPlatformRole('owner') && !isPlatformRole('root'));
    const req = read('src/lib/tenancy/request.ts');
    assert.match(req, /org\?\.status === 'suspended'\) throw new OrganizationAccessError/);
    assert.match(read('src/lib/tenancy/organizations.ts'), /emailDomainAllowed\(organization\.allowedEmailDomains, target\.email\)/);
    for (const rel of ['src/app/(app)/api/auth/login/route.ts', 'src/app/(app)/api/auth/exchange/route.ts']) {
      const text = read(rel);
      assert.match(text, /passwordSignInRefusal\(/, `${rel} honours requireSso`);
      assert.match(text, /maxHours: await sessionMaxHoursFor\(/, `${rel} honours the session ceiling`);
    }
  });
  it('the audit CSV neutralises formula cells, quotes commas and newlines, and carries no IP or user-agent column', () => {
    const csv = auditCsv([{ id: '1', createdAt: new Date('2026-09-05T00:00:00Z'), actorType: 'staff', actorEmail: 'a@b.test', actorRole: 'admin', action: 'x.y', entityType: 'T', entityId: 'e', summary: '=HYPERLINK("http://evil")', reason: 'a, "quoted"\nline' }]);
    const [header, line] = csv.split('\r\n');
    assert.equal(header, 'id,createdAt,actorType,actorEmail,actorRole,action,entityType,entityId,summary,reason');
    assert.ok(!/\bip\b|userAgent/.test(header));
    assert.ok(line!.includes(`"'=HYPERLINK(""http://evil"")"`));
    assert.ok(line!.includes('"a, ""quoted""\nline"'));
  });
  it('nothing under the Stage 20 modules reaches the sensitive schema, the AI gateway or the mailbox', () => {
    for (const dir of ['src/lib/sso', 'src/lib/scim', 'src/lib/admin']) {
      for (const f of files(path.join(root, dir))) assert.ok(!/lib\/sensitive|lib\/ai\/gateway|lib\/ai\/providers|lib\/mailbox\/(service|providers)/.test(readFileSync(f, 'utf8')), `${path.relative(root, f)} reaches a forbidden path`);
    }
  });
});
