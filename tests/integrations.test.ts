import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { beforeEach, describe, it } from 'node:test';

import {
  API_SCOPES,
  authenticateApiKey,
  expandScopes,
  extractApiKey,
  generateApiKey,
  hashApiKey,
  hasScope,
  maskApiKey,
  parseApiKey,
  parseScopes,
  secureEquals,
  serialiseScopes,
  toSafeApiKey,
  type ApiKeyRecord,
  type ApiKeyStore,
  type ApiScope,
} from '../src/lib/integrations/api-keys';
import {
  WEBHOOK_BACKOFF_CAP_SECONDS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_TOLERANCE_SECONDS,
  attemptDelivery,
  backoffSeconds,
  buildEventBody,
  computeSignature,
  generateWebhookSecret,
  isWebhookEventType,
  jitteredBackoffSeconds,
  matchesSubscription,
  nextRetryAt,
  parseSignatureHeader,
  parseSubscribedEvents,
  shouldRetryStatus,
  signatureHeader,
  signaturePayload,
  toSafeWebhookEndpoint,
  validateWebhookUrl,
  verifySignatureHeader,
  type WebhookTransport,
} from '../src/lib/integrations/webhooks';
import {
  CONNECTORS,
  CONNECTOR_IDS,
  genericWebhookConnector,
  getConnector,
  listConnectors,
  toSafeIntegration,
  zapierConnector,
  type ConnectorEvent,
} from '../src/lib/integrations/connectors';
import {
  listEnvelope,
  parseBoundedInt,
  parseEnumParam,
  parsePagination,
  rateLimitHeaders,
} from '../src/lib/integrations/http';
import {
  rateParts,
  serialiseApplication,
  serialiseJobMatch,
} from '../src/lib/integrations/public-api';
import { resetRateLimits } from '../src/lib/rate-limit';

const NOW = new Date('2026-08-14T12:00:00.000Z');

// ============================================================================
// API keys
// ============================================================================

describe('API key format', () => {
  it('generates a key that parses back to its own parts', () => {
    const generated = generateApiKey('live');
    const parsed = parseApiKey(generated.raw);

    assert.ok(parsed, 'a freshly generated key must parse');
    assert.equal(parsed.prefix, generated.prefix);
    assert.equal(parsed.environment, 'live');
    assert.equal(`${parsed.prefix}_${parsed.secret}`, generated.raw);
  });

  it('honours the requested environment', () => {
    assert.equal(generateApiKey('test').environment, 'test');
    assert.ok(generateApiKey('test').prefix.startsWith('jp_test_'));
    assert.ok(generateApiKey('live').prefix.startsWith('jp_live_'));
  });

  it('never produces the same key twice', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 250; i++) seen.add(generateApiKey('live').raw);
    assert.equal(seen.size, 250, 'generated keys must be unique');
  });

  it('carries at least 256 bits of secret', () => {
    const parsed = parseApiKey(generateApiKey('live').raw);
    assert.ok(parsed);
    // 64 hex characters = 32 bytes = 256 bits.
    assert.equal(parsed.secret.length, 64);
  });

  it('rejects anything that is not one of our keys', () => {
    for (const bad of [
      '',
      '   ',
      'hello',
      'jp_live_8f3a2b1c',
      'jp_live_8f3a2b1c_',
      'jp_prod_8f3a2b1c_' + 'a'.repeat(64),
      'jp_live_8F3A2B1C_' + 'a'.repeat(64), // uppercase prefix
      'jp_live_8f3a2b1c_' + 'a'.repeat(63), // one hex short
      'jp_live_8f3a2b1c_' + 'a'.repeat(65), // one hex long
      'jp_live_8f3a2b1c_' + 'z'.repeat(64), // not hex
      'xjp_live_8f3a2b1c_' + 'a'.repeat(64), // leading junk
    ]) {
      assert.equal(parseApiKey(bad), null, `"${bad.slice(0, 24)}…" must not parse`);
    }
    assert.equal(parseApiKey(null), null);
    assert.equal(parseApiKey(undefined), null);
  });

  it('tolerates surrounding whitespace from a copy-paste', () => {
    const generated = generateApiKey('live');
    assert.equal(parseApiKey(`  ${generated.raw}\n`)?.raw, generated.raw);
  });

  it('masks a key for display without revealing the secret', () => {
    const generated = generateApiKey('live');
    const masked = maskApiKey(generated.prefix);
    assert.ok(masked.startsWith('jp_live_'));
    assert.ok(!masked.includes(parseApiKey(generated.raw)!.secret));
  });
});

describe('API key hashing', () => {
  it('is deterministic — the same key always hashes the same way', () => {
    const { raw } = generateApiKey('live');
    assert.equal(hashApiKey(raw), hashApiKey(raw));
  });

  it('produces a 64-character hex sha256 digest', () => {
    assert.match(hashApiKey(generateApiKey('live').raw), /^[0-9a-f]{64}$/);
  });

  it('binds the secret to its prefix — swapping halves does not verify', () => {
    const a = parseApiKey(generateApiKey('live').raw)!;
    const b = parseApiKey(generateApiKey('live').raw)!;
    const frankenkey = `${a.prefix}_${b.secret}`;
    assert.notEqual(hashApiKey(frankenkey), hashApiKey(a.raw));
    assert.notEqual(hashApiKey(frankenkey), hashApiKey(b.raw));
  });

  it('changes completely when one character changes', () => {
    const { raw } = generateApiKey('live');
    const flipped = raw.slice(0, -1) + (raw.endsWith('a') ? 'b' : 'a');
    assert.notEqual(hashApiKey(raw), hashApiKey(flipped));
  });
});

describe('secureEquals', () => {
  it('accepts identical strings and rejects different ones', () => {
    assert.equal(secureEquals('abc', 'abc'), true);
    assert.equal(secureEquals('abc', 'abd'), false);
  });

  it('returns false for different lengths instead of throwing', () => {
    // timingSafeEqual throws on a length mismatch; the guard must absorb that.
    assert.doesNotThrow(() => secureEquals('abc', 'abcd'));
    assert.equal(secureEquals('abc', 'abcd'), false);
    assert.equal(secureEquals('', 'a'), false);
    assert.equal(secureEquals('', ''), true);
  });
});

describe('API key scopes', () => {
  it('round-trips through the JSON column', () => {
    const scopes: ApiScope[] = ['read', 'apply:write'];
    assert.deepEqual(parseScopes(serialiseScopes(scopes)).sort(), ['apply:write', 'read']);
  });

  it('drops unknown scope names rather than carrying them forward', () => {
    assert.deepEqual(parseScopes('["read","superuser","",null,7]'), ['read']);
  });

  it('survives a malformed or absent column', () => {
    assert.deepEqual(parseScopes('not json'), []);
    assert.deepEqual(parseScopes(null), []);
    assert.deepEqual(parseScopes('{"read":true}'), []);
  });

  it('de-duplicates', () => {
    assert.deepEqual(parseScopes('["read","read","read"]'), ['read']);
  });

  it('expands admin to every scope in the vocabulary', () => {
    const expanded = expandScopes(['admin']);
    for (const scope of API_SCOPES) {
      assert.ok(expanded.has(scope), `admin must confer ${scope}`);
    }
  });

  it('makes write imply read but not the reverse', () => {
    assert.equal(hasScope(['write'], 'read'), true);
    assert.equal(hasScope(['read'], 'write'), false);
    assert.equal(hasScope(['read'], 'apply:write'), false);
    assert.equal(hasScope(['write'], 'apply:write'), true);
  });

  it('does not confer admin on anyone who was not granted it', () => {
    assert.equal(hasScope(['write'], 'admin'), false);
    assert.equal(hasScope(['read', 'apply:write', 'scan:read'], 'admin'), false);
  });

  it('grants nothing to an empty scope list', () => {
    for (const scope of API_SCOPES) assert.equal(hasScope([], scope), false);
  });
});

// --- Authentication ---------------------------------------------------------

/** An in-memory ApiKeyStore, so authentication is testable without a database. */
function storeOf(...records: ApiKeyRecord[]): ApiKeyStore {
  const byPrefix = new Map(records.map((record) => [record.prefix, record]));
  return { findByPrefix: async (prefix) => byPrefix.get(prefix) ?? null };
}

function recordFor(
  raw: string,
  prefix: string,
  overrides: Partial<ApiKeyRecord> = {},
): ApiKeyRecord {
  return {
    id: 'key_1',
    userId: 'user_1',
    organizationId: null,
    name: 'Test key',
    prefix,
    keyHash: hashApiKey(raw),
    scopes: '["read"]',
    environment: 'live',
    rateLimitPerMinute: 60,
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

describe('authenticateApiKey', () => {
  it('accepts a valid key and returns its parsed scopes', async () => {
    const { raw, prefix } = generateApiKey('live');
    const result = await authenticateApiKey(storeOf(recordFor(raw, prefix)), raw, { now: NOW });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.key.userId, 'user_1');
    assert.deepEqual(result.key.scopes, ['read']);
    assert.equal(result.key.environment, 'live');
  });

  it('refuses a missing credential with a message that says how to send one', async () => {
    for (const empty of [null, undefined, '', '   ']) {
      const result = await authenticateApiKey(storeOf(), empty, { now: NOW });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.reason, 'missing');
      assert.equal(result.status, 401);
      assert.match(result.message, /Authorization: Bearer|X-API-Key/);
    }
  });

  it('refuses a key whose secret is wrong even when the prefix is real', async () => {
    const genuine = generateApiKey('live');
    const forged = `${genuine.prefix}_${'0'.repeat(64)}`;
    const result = await authenticateApiKey(
      storeOf(recordFor(genuine.raw, genuine.prefix)),
      forged,
      { now: NOW },
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'unknown');
  });

  it('refuses a revoked key', async () => {
    const { raw, prefix } = generateApiKey('live');
    const revokedAt = new Date(NOW.getTime() - 1000);
    const result = await authenticateApiKey(
      storeOf(recordFor(raw, prefix, { revokedAt })),
      raw,
      { now: NOW },
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'revoked');
  });

  it('refuses an expired key but accepts one expiring later', async () => {
    const { raw, prefix } = generateApiKey('live');

    const expired = await authenticateApiKey(
      storeOf(recordFor(raw, prefix, { expiresAt: new Date(NOW.getTime() - 1) })),
      raw,
      { now: NOW },
    );
    assert.equal(expired.ok, false);
    if (!expired.ok) assert.equal(expired.reason, 'expired');

    const valid = await authenticateApiKey(
      storeOf(recordFor(raw, prefix, { expiresAt: new Date(NOW.getTime() + 60_000) })),
      raw,
      { now: NOW },
    );
    assert.equal(valid.ok, true);
  });

  it('refuses a key with no owning user, so it cannot read unscoped', async () => {
    const { raw, prefix } = generateApiKey('live');
    const result = await authenticateApiKey(
      storeOf(recordFor(raw, prefix, { userId: null })),
      raw,
      { now: NOW },
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'orphaned');
  });

  it('gives the same message for unknown, malformed and revoked keys', async () => {
    const { raw, prefix } = generateApiKey('live');
    const store = storeOf(recordFor(raw, prefix, { revokedAt: new Date(NOW.getTime() - 1) }));

    const revoked = await authenticateApiKey(store, raw, { now: NOW });
    const unknown = await authenticateApiKey(store, generateApiKey('live').raw, { now: NOW });
    const malformed = await authenticateApiKey(store, 'not-a-key', { now: NOW });

    assert.equal(revoked.ok, false);
    assert.equal(unknown.ok, false);
    assert.equal(malformed.ok, false);
    if (revoked.ok || unknown.ok || malformed.ok) return;
    // A prober must not be able to tell a real prefix from a fabricated one.
    assert.equal(revoked.message, unknown.message);
    assert.equal(unknown.message, malformed.message);
    assert.equal(revoked.status, 401);
  });

  it('answers 403 with a specific message when the scope is missing', async () => {
    const { raw, prefix } = generateApiKey('live');
    const result = await authenticateApiKey(
      storeOf(recordFor(raw, prefix, { scopes: '["read"]' })),
      raw,
      { now: NOW, requiredScope: 'apply:write' },
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'insufficient_scope');
    assert.equal(result.status, 403);
    assert.match(result.message, /apply:write/);
  });

  it('accepts an admin key for any required scope', async () => {
    const { raw, prefix } = generateApiKey('live');
    const store = storeOf(recordFor(raw, prefix, { scopes: '["admin"]' }));
    for (const scope of API_SCOPES) {
      const result = await authenticateApiKey(store, raw, { now: NOW, requiredScope: scope });
      assert.equal(result.ok, true, `admin must satisfy ${scope}`);
    }
  });
});

describe('extractApiKey', () => {
  it('reads a bearer token', () => {
    const request = new Request('https://x.test', { headers: { authorization: 'Bearer abc123' } });
    assert.equal(extractApiKey(request), 'abc123');
  });

  it('accepts any capitalisation of the bearer scheme', () => {
    const request = new Request('https://x.test', { headers: { authorization: 'bearer abc123' } });
    assert.equal(extractApiKey(request), 'abc123');
  });

  it('falls back to X-API-Key', () => {
    const request = new Request('https://x.test', { headers: { 'x-api-key': 'abc123' } });
    assert.equal(extractApiKey(request), 'abc123');
  });

  it('prefers the bearer token when both are present', () => {
    const request = new Request('https://x.test', {
      headers: { authorization: 'Bearer intended', 'x-api-key': 'stale' },
    });
    assert.equal(extractApiKey(request), 'intended');
  });

  it('returns null when no credential is present', () => {
    assert.equal(extractApiKey(new Request('https://x.test')), null);
    assert.equal(
      extractApiKey(new Request('https://x.test', { headers: { authorization: 'Basic abc' } })),
      null,
    );
  });
});

describe('a raw key is never persisted', () => {
  it('keeps no trace of the secret in the row we would write', () => {
    const generated = generateApiKey('live');
    const secret = parseApiKey(generated.raw)!.secret;

    // Exactly the object src/lib/integrations/api-keys.ts::createApiKey builds.
    const persisted = {
      userId: 'user_1',
      name: 'CI key',
      prefix: generated.prefix,
      keyHash: generated.keyHash,
      scopes: serialiseScopes(['read']),
      environment: 'live',
      rateLimitPerMinute: 60,
      expiresAt: null,
    };

    const serialised = JSON.stringify(persisted);
    assert.ok(!serialised.includes(generated.raw), 'the full key must not be stored');
    assert.ok(!serialised.includes(secret), 'the secret half must not be stored');
    assert.ok(serialised.includes(generated.keyHash), 'the hash is what gets stored');
  });

  it('never returns the hash or the secret from toSafeApiKey', () => {
    const generated = generateApiKey('live');
    const safe = toSafeApiKey(
      {
        ...recordFor(generated.raw, generated.prefix),
        requestCount: 3,
        lastUsedAt: NOW,
        createdAt: NOW,
      },
      NOW,
    );

    const serialised = JSON.stringify(safe);
    assert.ok(!serialised.includes(generated.keyHash), 'the hash must not reach a client');
    assert.ok(!serialised.includes(generated.raw), 'the raw key must not reach a client');
    assert.ok(!('keyHash' in safe), 'keyHash must not be a property at all');
    assert.equal(safe.prefix, generated.prefix, 'the prefix is safe and identifies the key');
  });

  it('reports revocation state relative to a given instant', () => {
    const generated = generateApiKey('live');
    const base = {
      ...recordFor(generated.raw, generated.prefix),
      requestCount: 0,
      lastUsedAt: null,
      createdAt: NOW,
    };

    assert.equal(toSafeApiKey(base, NOW).revoked, false);
    assert.equal(
      toSafeApiKey({ ...base, revokedAt: new Date(NOW.getTime() - 1) }, NOW).revoked,
      true,
    );
  });
});

// ============================================================================
// Webhook signatures
// ============================================================================

describe('HMAC signature, against a known vector', () => {
  /**
   * A fixed vector, computed independently of the implementation. Anyone can
   * reproduce it from a shell:
   *
   *   printf '1755172800.{"id":"evt_1","type":"ping"}' \
   *     | openssl dgst -sha256 -hmac 'whsec_test_secret' -hex
   *
   * If this test fails, the wire format changed and every receiver in the world
   * that verified our deliveries yesterday stops verifying them today.
   */
  const SECRET = 'whsec_test_secret';
  const TIMESTAMP = 1_755_172_800;
  const BODY = '{"id":"evt_1","type":"ping"}';

  /**
   * Hard-coded, NOT recomputed. A vector derived from the same primitive the
   * implementation uses would still pass if the construction changed — a
   * different separator, the arguments swapped, the timestamp omitted — because
   * both sides would change together. This literal is the frozen wire format.
   */
  const EXPECTED = '1f99b2f165a0a398189db0813bb6092e38362437a16c560d2e286805bd54a2e6';

  it('signs exactly `timestamp.body`', () => {
    assert.equal(signaturePayload(TIMESTAMP, BODY), `${TIMESTAMP}.${BODY}`);
    assert.equal(signaturePayload(TIMESTAMP, BODY), '1755172800.{"id":"evt_1","type":"ping"}');
  });

  it('matches the documented HMAC-SHA256 construction', () => {
    assert.equal(computeSignature(SECRET, TIMESTAMP, BODY), EXPECTED);
  });

  it('produces lowercase hex of exactly 64 characters', () => {
    assert.match(computeSignature(SECRET, TIMESTAMP, BODY), /^[0-9a-f]{64}$/);
  });

  it('agrees with an independent HMAC of the documented message', () => {
    // The same value a receiver gets from `openssl dgst -sha256 -hmac`, which
    // is the command in the module comment. If these ever disagree, the comment
    // is lying to whoever is trying to implement verification.
    assert.equal(
      EXPECTED,
      createHmac('sha256', Buffer.from(SECRET, 'utf8'))
        .update(Buffer.from(`${TIMESTAMP}.${BODY}`, 'utf8'))
        .digest('hex'),
    );
  });

  it('changes when the secret changes', () => {
    assert.notEqual(computeSignature('whsec_other', TIMESTAMP, BODY), EXPECTED);
  });

  it('changes when the timestamp changes — this is what stops replay', () => {
    assert.notEqual(computeSignature(SECRET, TIMESTAMP + 1, BODY), EXPECTED);
  });

  it('changes when a single byte of the body changes', () => {
    assert.notEqual(computeSignature(SECRET, TIMESTAMP, `${BODY} `), EXPECTED);
    assert.notEqual(
      computeSignature(SECRET, TIMESTAMP, '{"type":"ping","id":"evt_1"}'),
      EXPECTED,
      're-ordered JSON keys are a different body — receivers must not re-serialise',
    );
  });

  it('formats the header as t=…,v1=…', () => {
    assert.equal(signatureHeader(SECRET, TIMESTAMP, BODY), `t=${TIMESTAMP},v1=${EXPECTED}`);
  });
});

describe('parseSignatureHeader', () => {
  it('reads the timestamp and signature', () => {
    const parsed = parseSignatureHeader('t=1755172800,v1=abc');
    assert.equal(parsed.timestamp, 1_755_172_800);
    assert.deepEqual(parsed.signatures, ['abc']);
  });

  it('collects several v1 values, as sent during a secret rotation', () => {
    const parsed = parseSignatureHeader('t=1,v1=old,v1=new');
    assert.deepEqual(parsed.signatures, ['old', 'new']);
  });

  it('ignores unknown elements so a future v2 does not break receivers', () => {
    const parsed = parseSignatureHeader('t=1,v1=abc,v2=def,junk');
    assert.equal(parsed.timestamp, 1);
    assert.deepEqual(parsed.signatures, ['abc']);
  });

  it('tolerates whitespace between elements', () => {
    const parsed = parseSignatureHeader(' t=1 , v1=abc ');
    assert.equal(parsed.timestamp, 1);
    assert.deepEqual(parsed.signatures, ['abc']);
  });

  it('reports nothing for absent or unusable headers', () => {
    for (const header of [null, undefined, '', 'garbage', 't=nope']) {
      const parsed = parseSignatureHeader(header);
      assert.equal(parsed.timestamp, null);
      assert.deepEqual(parsed.signatures, []);
    }
  });
});

describe('verifySignatureHeader', () => {
  const SECRET = 'whsec_verify_me';
  const BODY = '{"hello":"world"}';
  const seconds = Math.floor(NOW.getTime() / 1000);

  it('accepts a signature we just produced', () => {
    const header = signatureHeader(SECRET, seconds, BODY);
    assert.deepEqual(verifySignatureHeader(SECRET, BODY, header, { now: NOW }), { ok: true });
  });

  it('rejects the wrong secret', () => {
    const header = signatureHeader('whsec_attacker', seconds, BODY);
    const result = verifySignatureHeader(SECRET, BODY, header, { now: NOW });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'signature_mismatch');
  });

  it('rejects a tampered body', () => {
    const header = signatureHeader(SECRET, seconds, BODY);
    const result = verifySignatureHeader(SECRET, '{"hello":"mars"}', header, { now: NOW });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'signature_mismatch');
  });

  it('rejects a replay from outside the tolerance window', () => {
    const stale = seconds - WEBHOOK_TOLERANCE_SECONDS - 1;
    const header = signatureHeader(SECRET, stale, BODY);
    const result = verifySignatureHeader(SECRET, BODY, header, { now: NOW });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'timestamp_out_of_tolerance');
  });

  it('accepts a delivery at the very edge of the window', () => {
    const edge = seconds - WEBHOOK_TOLERANCE_SECONDS;
    const header = signatureHeader(SECRET, edge, BODY);
    assert.equal(verifySignatureHeader(SECRET, BODY, header, { now: NOW }).ok, true);
  });

  it('rejects a timestamp too far in the future, not only the past', () => {
    const ahead = seconds + WEBHOOK_TOLERANCE_SECONDS + 1;
    const header = signatureHeader(SECRET, ahead, BODY);
    const result = verifySignatureHeader(SECRET, BODY, header, { now: NOW });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'timestamp_out_of_tolerance');
  });

  it('accepts when any of several v1 values matches', () => {
    const good = computeSignature(SECRET, seconds, BODY);
    const header = `t=${seconds},v1=${'0'.repeat(64)},v1=${good}`;
    assert.equal(verifySignatureHeader(SECRET, BODY, header, { now: NOW }).ok, true);
  });

  it('names the specific reason for each malformed header', () => {
    const cases: [string | null, string][] = [
      [null, 'missing_header'],
      ['v1=abc', 'missing_timestamp'],
      [`t=${seconds}`, 'missing_signature'],
    ];
    for (const [header, reason] of cases) {
      const result = verifySignatureHeader(SECRET, BODY, header, { now: NOW });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason, reason);
    }
  });

  it('rejects a signature of the wrong length without throwing', () => {
    const header = `t=${seconds},v1=abc`;
    assert.doesNotThrow(() => verifySignatureHeader(SECRET, BODY, header, { now: NOW }));
    assert.equal(verifySignatureHeader(SECRET, BODY, header, { now: NOW }).ok, false);
  });

  it('round-trips whatever buildEventBody produces', () => {
    const body = buildEventBody({
      id: 'evt_1',
      type: 'application.submitted',
      payload: '{"applicationId":"app_1"}',
      occurredAt: NOW,
      apiVersion: '2026-01-01',
    });
    const header = signatureHeader(SECRET, seconds, body);
    assert.equal(verifySignatureHeader(SECRET, body, header, { now: NOW }).ok, true);

    const decoded = JSON.parse(body);
    assert.equal(decoded.id, 'evt_1');
    assert.equal(decoded.type, 'application.submitted');
    assert.deepEqual(decoded.data, { applicationId: 'app_1' });
  });
});

describe('generateWebhookSecret', () => {
  it('is prefixed, long, and never repeats', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const secret = generateWebhookSecret();
      assert.ok(secret.startsWith('whsec_'));
      assert.equal(secret.length, 'whsec_'.length + 64);
      seen.add(secret);
    }
    assert.equal(seen.size, 100);
  });
});

// ============================================================================
// Retry and backoff
// ============================================================================

describe('backoff schedule', () => {
  it('follows the documented exponential progression', () => {
    assert.equal(backoffSeconds(1), 60);
    assert.equal(backoffSeconds(2), 240);
    assert.equal(backoffSeconds(3), 960);
    assert.equal(backoffSeconds(4), 3840);
    assert.equal(backoffSeconds(5), 15_360);
  });

  it('returns null once the attempt budget is spent', () => {
    assert.equal(backoffSeconds(WEBHOOK_MAX_ATTEMPTS), null);
    assert.equal(backoffSeconds(WEBHOOK_MAX_ATTEMPTS + 5), null);
  });

  it('gives exactly WEBHOOK_MAX_ATTEMPTS - 1 gaps', () => {
    const gaps = [];
    for (let attempt = 1; backoffSeconds(attempt) !== null; attempt++) {
      gaps.push(backoffSeconds(attempt)!);
      assert.ok(attempt < 100, 'the schedule must terminate');
    }
    assert.equal(gaps.length, WEBHOOK_MAX_ATTEMPTS - 1);
  });

  it('increases strictly until it reaches the cap', () => {
    for (let attempt = 1; attempt < WEBHOOK_MAX_ATTEMPTS - 1; attempt++) {
      const current = backoffSeconds(attempt)!;
      const next = backoffSeconds(attempt + 1)!;
      assert.ok(next > current, `gap ${attempt + 1} must exceed gap ${attempt}`);
    }
  });

  it('never exceeds the cap', () => {
    for (let attempt = 1; attempt < WEBHOOK_MAX_ATTEMPTS; attempt++) {
      assert.ok(backoffSeconds(attempt)! <= WEBHOOK_BACKOFF_CAP_SECONDS);
    }
  });

  it('spans between one and eight hours in total', () => {
    let total = 0;
    for (let attempt = 1; attempt < WEBHOOK_MAX_ATTEMPTS; attempt++) {
      total += backoffSeconds(attempt)!;
    }
    assert.equal(total, 60 + 240 + 960 + 3840 + 15_360);
    assert.ok(total > 3_600, 'a short outage must not exhaust the budget');
    assert.ok(total < 28_800, 'a dead endpoint must not be retried for a whole day');
  });

  it('refuses a nonsensical attempt number rather than inventing a delay', () => {
    assert.throws(() => backoffSeconds(0), /positive integer/);
    assert.throws(() => backoffSeconds(-1), /positive integer/);
    assert.throws(() => backoffSeconds(1.5), /positive integer/);
  });
});

describe('jittered backoff', () => {
  it('is exactly the base delay at the midpoint', () => {
    for (let attempt = 1; attempt < WEBHOOK_MAX_ATTEMPTS; attempt++) {
      assert.equal(jitteredBackoffSeconds(attempt, 0.5), backoffSeconds(attempt));
    }
  });

  it('spreads ±20% across the extremes', () => {
    assert.equal(jitteredBackoffSeconds(1, 0), Math.round(60 * 0.8));
    assert.equal(jitteredBackoffSeconds(1, 1), Math.round(60 * 1.2));
  });

  it('stays inside ±20% for any random draw', () => {
    for (let i = 0; i < 500; i++) {
      const ratio = Math.random();
      const value = jitteredBackoffSeconds(3, ratio)!;
      assert.ok(value >= Math.round(960 * 0.8), `${value} below the jitter floor`);
      assert.ok(value <= Math.round(960 * 1.2), `${value} above the jitter ceiling`);
    }
  });

  it('clamps a jitter ratio outside 0..1 instead of extrapolating', () => {
    assert.equal(jitteredBackoffSeconds(1, -5), jitteredBackoffSeconds(1, 0));
    assert.equal(jitteredBackoffSeconds(1, 5), jitteredBackoffSeconds(1, 1));
  });

  it('never schedules a zero-second retry', () => {
    assert.ok(jitteredBackoffSeconds(1, 0)! >= 1);
  });

  it('returns null when the base schedule is exhausted', () => {
    assert.equal(jitteredBackoffSeconds(WEBHOOK_MAX_ATTEMPTS, 0.5), null);
  });
});

describe('nextRetryAt', () => {
  it('lands the base delay after the given instant', () => {
    const at = nextRetryAt(1, NOW, 0.5);
    assert.ok(at);
    assert.equal(at.getTime() - NOW.getTime(), 60_000);
  });

  it('is null on the final attempt, which is how callers detect exhaustion', () => {
    assert.equal(nextRetryAt(WEBHOOK_MAX_ATTEMPTS, NOW, 0.5), null);
  });

  it('produces a strictly increasing sequence of retry instants', () => {
    let cursor = NOW;
    let previousGap = 0;
    for (let attempt = 1; attempt < WEBHOOK_MAX_ATTEMPTS; attempt++) {
      const at = nextRetryAt(attempt, cursor, 0.5)!;
      const gap = at.getTime() - cursor.getTime();
      assert.ok(gap > previousGap, 'each wait must be longer than the last');
      previousGap = gap;
      cursor = at;
    }
  });
});

describe('shouldRetryStatus', () => {
  it('retries server errors', () => {
    for (const status of [500, 502, 503, 504, 599]) {
      assert.equal(shouldRetryStatus(status), true, `${status} must be retried`);
    }
  });

  it('retries the two 4xx statuses that mean "later", and no others', () => {
    assert.equal(shouldRetryStatus(408), true);
    assert.equal(shouldRetryStatus(429), true);
    for (const status of [400, 401, 403, 404, 410, 422]) {
      assert.equal(shouldRetryStatus(status), false, `${status} must not be retried`);
    }
  });

  it('does not retry a success', () => {
    for (const status of [200, 201, 202, 204]) assert.equal(shouldRetryStatus(status), false);
  });
});

// ============================================================================
// Delivery
// ============================================================================

/** A transport that answers with a fixed status, recording what it was sent. */
function transportReturning(status: number, body = 'ok') {
  const sent: { url: string; body: string; headers: Record<string, string> }[] = [];
  const transport: WebhookTransport = async (request) => {
    sent.push({ url: request.url, body: request.body, headers: request.headers });
    return { status, body };
  };
  return { transport, sent };
}

const TARGET = {
  id: 'wh_1',
  url: 'https://receiver.test/hook',
  secret: 'whsec_delivery',
  apiVersion: '2026-01-01',
};

const PAYLOAD = {
  eventId: 'evt_1',
  type: 'application.submitted',
  body: '{"id":"evt_1","type":"application.submitted"}',
};

describe('attemptDelivery', () => {
  it('succeeds on 2xx and schedules nothing further', async () => {
    const { transport, sent } = transportReturning(200);
    const result = await attemptDelivery(TARGET, PAYLOAD, 1, { transport, now: NOW });

    assert.equal(result.status, 'succeeded');
    assert.equal(result.responseStatus, 200);
    assert.equal(result.retryAt, null);
    assert.equal(result.nextAttempt, null);
    assert.equal(sent.length, 1);
  });

  it('sends a signature the receiver can verify with the documented recipe', async () => {
    const { transport, sent } = transportReturning(200);
    await attemptDelivery(TARGET, PAYLOAD, 1, { transport, now: NOW });

    const header = sent[0].headers['JobPilot-Signature'];
    assert.ok(header, 'every delivery must carry a signature');
    assert.equal(
      verifySignatureHeader(TARGET.secret, sent[0].body, header, { now: NOW }).ok,
      true,
    );
  });

  it('carries the event type, the stable event id and the attempt number', async () => {
    const { transport, sent } = transportReturning(200);
    await attemptDelivery(TARGET, PAYLOAD, 3, { transport, now: NOW, deliveryId: 'dlv_9' });

    assert.equal(sent[0].headers['JobPilot-Event'], 'application.submitted');
    assert.equal(sent[0].headers['JobPilot-Event-Id'], 'evt_1');
    assert.equal(sent[0].headers['JobPilot-Attempt'], '3');
    assert.equal(sent[0].headers['JobPilot-Delivery'], 'dlv_9');
    assert.equal(sent[0].headers['Content-Type'], 'application/json');
  });

  it('schedules a retry after a 500', async () => {
    const { transport } = transportReturning(500, 'boom');
    const result = await attemptDelivery(TARGET, PAYLOAD, 1, {
      transport,
      now: NOW,
      jitterRatio: 0.5,
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.nextAttempt, 2);
    assert.ok(result.retryAt);
    assert.equal(result.retryAt.getTime() - NOW.getTime(), 60_000);
  });

  it('gives up immediately on a 4xx that cannot succeed later', async () => {
    const { transport } = transportReturning(404);
    const result = await attemptDelivery(TARGET, PAYLOAD, 1, { transport, now: NOW });

    assert.equal(result.status, 'exhausted');
    assert.equal(result.retryAt, null);
    assert.match(result.errorMessage ?? '', /not retryable/);
  });

  it('is exhausted rather than failed on the final attempt', async () => {
    const { transport } = transportReturning(503);
    const result = await attemptDelivery(TARGET, PAYLOAD, WEBHOOK_MAX_ATTEMPTS, {
      transport,
      now: NOW,
    });

    assert.equal(result.status, 'exhausted');
    assert.equal(result.retryAt, null);
    assert.equal(result.nextAttempt, null);
  });

  it('treats a transport failure as retryable', async () => {
    const transport: WebhookTransport = async () => {
      throw new Error('ECONNREFUSED');
    };
    const result = await attemptDelivery(TARGET, PAYLOAD, 1, {
      transport,
      now: NOW,
      jitterRatio: 0.5,
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.responseStatus, null);
    assert.equal(result.errorMessage, 'ECONNREFUSED');
    assert.ok(result.retryAt);
  });

  it('walks the whole schedule to exhaustion for a permanently broken receiver', async () => {
    const { transport, sent } = transportReturning(500);
    let attempt = 1;
    let cursor = NOW;
    const gaps: number[] = [];

    for (;;) {
      const result = await attemptDelivery(TARGET, PAYLOAD, attempt, {
        transport,
        now: cursor,
        jitterRatio: 0.5,
      });
      if (result.status === 'exhausted') break;
      assert.ok(result.retryAt && result.nextAttempt);
      gaps.push((result.retryAt.getTime() - cursor.getTime()) / 1000);
      cursor = result.retryAt;
      attempt = result.nextAttempt;
      assert.ok(attempt <= WEBHOOK_MAX_ATTEMPTS, 'must never exceed the attempt budget');
    }

    assert.equal(sent.length, WEBHOOK_MAX_ATTEMPTS, 'exactly six attempts are made');
    assert.deepEqual(gaps, [60, 240, 960, 3840, 15_360]);
  });
});

// ============================================================================
// Subscriptions and endpoints
// ============================================================================

describe('matchesSubscription', () => {
  it('matches an exact event', () => {
    assert.equal(matchesSubscription(['application.submitted'], 'application.submitted'), true);
    assert.equal(matchesSubscription(['application.submitted'], 'job.matched'), false);
  });

  it('matches everything under "*"', () => {
    assert.equal(matchesSubscription(['*'], 'invoice.paid'), true);
    assert.equal(matchesSubscription(['*'], 'anything.at.all'), true);
  });

  it('matches a namespace wildcard', () => {
    assert.equal(matchesSubscription(['application.*'], 'application.submitted'), true);
    assert.equal(matchesSubscription(['application.*'], 'application.status_changed'), true);
    assert.equal(matchesSubscription(['application.*'], 'job.matched'), false);
  });

  it('does not let a namespace wildcard match the bare namespace', () => {
    assert.equal(matchesSubscription(['application.*'], 'application'), false);
  });

  it('does not let a wildcard leak across a namespace boundary', () => {
    assert.equal(matchesSubscription(['job.*'], 'jobseeker.thing'), false);
  });

  it('matches nothing for an empty subscription', () => {
    assert.equal(matchesSubscription([], 'invoice.paid'), false);
  });
});

describe('parseSubscribedEvents', () => {
  it('keeps catalogue events and wildcards', () => {
    assert.deepEqual(parseSubscribedEvents('["application.submitted","job.*","*"]').sort(), [
      '*',
      'application.submitted',
      'job.*',
    ]);
  });

  it('drops unknown non-wildcard events', () => {
    assert.deepEqual(parseSubscribedEvents('["application.submitted","made.up.event"]'), [
      'application.submitted',
    ]);
  });

  it('survives a malformed column', () => {
    assert.deepEqual(parseSubscribedEvents('nonsense'), []);
    assert.deepEqual(parseSubscribedEvents(null), []);
    assert.deepEqual(parseSubscribedEvents('[1,2,3]'), []);
  });

  it('agrees with isWebhookEventType about the catalogue', () => {
    assert.equal(isWebhookEventType('invoice.paid'), true);
    assert.equal(isWebhookEventType('ping'), false, 'ping is not subscribable');
    assert.equal(isWebhookEventType('nope'), false);
  });
});

describe('toSafeWebhookEndpoint', () => {
  it('never exposes the signing secret', () => {
    const safe = toSafeWebhookEndpoint({
      id: 'wh_1',
      url: 'https://receiver.test/hook',
      description: '',
      events: '["invoice.paid"]',
      status: 'active',
      apiVersion: '2026-01-01',
      consecutiveFailures: 0,
      disabledAt: null,
      disabledReason: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      createdAt: NOW,
    });

    assert.ok(!('secret' in safe), 'the secret must not be a property');
    assert.ok(!JSON.stringify(safe).includes('whsec'), 'no secret may appear in the payload');
    assert.deepEqual(safe.events, ['invoice.paid']);
  });
});

describe('validateWebhookUrl', () => {
  it('accepts a public https URL', () => {
    assert.equal(validateWebhookUrl('https://receiver.example.com/hook').ok, true);
  });

  it('rejects a non-http scheme', () => {
    for (const url of ['ftp://x.test/', 'file:///etc/passwd', 'javascript:alert(1)']) {
      const result = validateWebhookUrl(url);
      assert.equal(result.ok, false, `${url} must be rejected`);
    }
  });

  it('rejects a string that is not a URL at all', () => {
    assert.equal(validateWebhookUrl('not a url').ok, false);
    assert.equal(validateWebhookUrl('').ok, false);
  });

  it('blocks private and metadata addresses in production', () => {
    const original = process.env.NODE_ENV;
    try {
      // NODE_ENV is readonly in the Next types but writable at runtime; this is
      // the only way to exercise the production branch from a test.
      (process.env as Record<string, string>).NODE_ENV = 'production';
      for (const url of [
        'http://receiver.example.com/hook', // plain http
        'https://localhost/hook',
        'https://127.0.0.1/hook',
        'https://10.1.2.3/hook',
        'https://192.168.0.5/hook',
        'https://172.16.0.1/hook',
        'https://169.254.169.254/latest/meta-data/', // cloud metadata
        'https://[::1]/hook',
      ]) {
        assert.equal(validateWebhookUrl(url).ok, false, `${url} must be blocked in production`);
      }
      assert.equal(validateWebhookUrl('https://receiver.example.com/hook').ok, true);
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = original;
    }
  });
});

// ============================================================================
// Connectors
// ============================================================================

const CONNECTOR_EVENT: ConnectorEvent = {
  id: 'evt_1',
  type: 'application.submitted',
  occurredAt: NOW,
  data: { applicationId: 'app_1' },
};

describe('connector registry', () => {
  it('registers every declared id exactly once', () => {
    assert.equal(listConnectors().length, CONNECTOR_IDS.length);
    for (const id of CONNECTOR_IDS) {
      assert.equal(CONNECTORS[id].id, id, `${id} must be registered under its own id`);
      assert.equal(getConnector(id)?.id, id);
    }
  });

  it('returns null for an unknown connector', () => {
    assert.equal(getConnector('myspace'), null);
    assert.equal(getConnector(''), null);
  });
});

describe('generic webhook connector', () => {
  it('validates and normalises a configuration', () => {
    const result = genericWebhookConnector.validateConfig({
      url: 'https://receiver.example.com/hook',
      secret: 'a'.repeat(20),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.config.url, 'https://receiver.example.com/hook');
    assert.equal(genericWebhookConnector.isConfigured(result.config), true);
  });

  it('refuses a bad URL through the same guard the endpoint form uses', () => {
    assert.equal(genericWebhookConnector.validateConfig({ url: 'ftp://x.test' }).ok, false);
    assert.equal(genericWebhookConnector.validateConfig({}).ok, false);
  });

  it('refuses a signing secret that is too short to be worth anything', () => {
    const result = genericWebhookConnector.validateConfig({
      url: 'https://receiver.example.com/hook',
      secret: 'short',
    });
    assert.equal(result.ok, false);
  });

  it('reports unconfigured rather than throwing when no URL is set', async () => {
    const { transport } = transportReturning(200);
    const result = await genericWebhookConnector.deliver(
      { userId: 'user_1', config: {}, now: NOW, transport },
      CONNECTOR_EVENT,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'unconfigured');
  });

  it('delivers, and signs when a secret is configured', async () => {
    const { transport, sent } = transportReturning(200);
    const result = await genericWebhookConnector.deliver(
      {
        userId: 'user_1',
        config: { url: 'https://receiver.example.com/hook', secret: 'whsec_connector' },
        now: NOW,
        transport,
      },
      CONNECTOR_EVENT,
    );

    assert.equal(result.ok, true);
    assert.equal(
      verifySignatureHeader(
        'whsec_connector',
        sent[0].body,
        sent[0].headers['JobPilot-Signature'],
        { now: NOW },
      ).ok,
      true,
    );
  });

  it('omits the signature when no secret is configured', async () => {
    const { transport, sent } = transportReturning(200);
    await genericWebhookConnector.deliver(
      { userId: 'user_1', config: { url: 'https://receiver.example.com/hook' }, now: NOW, transport },
      CONNECTOR_EVENT,
    );
    assert.equal(sent[0].headers['JobPilot-Signature'], undefined);
  });

  it('will not let a configured header overwrite the signature or content type', async () => {
    const { transport, sent } = transportReturning(200);
    await genericWebhookConnector.deliver(
      {
        userId: 'user_1',
        config: {
          url: 'https://receiver.example.com/hook',
          secret: 'whsec_connector',
          headers: {
            'JobPilot-Signature': 'forged',
            'Content-Type': 'text/plain',
            Authorization: 'Bearer downstream',
          },
        },
        now: NOW,
        transport,
      },
      CONNECTOR_EVENT,
    );

    assert.notEqual(sent[0].headers['JobPilot-Signature'], 'forged');
    assert.equal(sent[0].headers['Content-Type'], 'application/json');
    assert.equal(sent[0].headers['Authorization'], 'Bearer downstream', 'other headers pass through');
  });

  it('reports a non-2xx as an error rather than a success', async () => {
    const { transport } = transportReturning(500);
    const result = await genericWebhookConnector.deliver(
      { userId: 'user_1', config: { url: 'https://receiver.example.com/hook' }, now: NOW, transport },
      CONNECTOR_EVENT,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'error');
    assert.equal(result.responseStatus, 500);
  });

  it('turns a thrown transport error into a failure result', async () => {
    const transport: WebhookTransport = async () => {
      throw new Error('DNS failure');
    };
    const result = await genericWebhookConnector.deliver(
      { userId: 'user_1', config: { url: 'https://receiver.example.com/hook' }, now: NOW, transport },
      CONNECTOR_EVENT,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.message, 'DNS failure');
  });
});

describe('zapier connector', () => {
  it('is implemented and drops any signing secret', () => {
    assert.equal(zapierConnector.implemented, true);
    const result = zapierConnector.validateConfig({
      url: 'https://hooks.zapier.com/hooks/catch/1/abc/',
      secret: 'a'.repeat(20),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(!('secret' in result.config), 'Zapier cannot verify signatures, so none is stored');
  });
});

describe('unimplemented connectors are honest about it', () => {
  const unimplemented = listConnectors().filter((connector) => !connector.implemented);

  it('registers Slack, Google Sheets and Calendar as known but not working', () => {
    assert.deepEqual(
      unimplemented.map((connector) => connector.id).sort(),
      ['google_calendar', 'google_drive', 'slack'],
    );
  });

  it('refuses to be configured', () => {
    for (const connector of unimplemented) {
      const result = connector.validateConfig({ anything: 'goes' });
      assert.equal(result.ok, false, `${connector.id} must refuse configuration`);
      if (result.ok) continue;
      assert.match(result.message, /not implemented/);
    }
  });

  it('never reports itself as configured', () => {
    for (const connector of unimplemented) {
      assert.equal(connector.isConfigured({ channelId: 'C123' }), false);
    }
  });

  it('fails every delivery with `unavailable` and a reason', async () => {
    const { transport } = transportReturning(200);
    for (const connector of unimplemented) {
      const result = await connector.deliver(
        { userId: 'user_1', config: {}, now: NOW, transport },
        CONNECTOR_EVENT,
      );
      assert.equal(result.ok, false, `${connector.id} must not report success`);
      if (result.ok) continue;
      assert.equal(result.kind, 'unavailable');
      assert.match(result.message, /not implemented/);
    }
  });

  it('still declares the fields a real implementation would need', () => {
    for (const connector of unimplemented) {
      assert.ok(connector.configFields.length > 0, `${connector.id} must declare its config shape`);
      assert.ok(connector.configFields.some((field) => field.required));
    }
  });
});

describe('toSafeIntegration', () => {
  it('reports which fields are set without revealing their values', () => {
    const safe = toSafeIntegration({
      id: 'int_1',
      provider: 'webhook',
      status: 'connected',
      displayName: 'Custom webhook',
      config: '{"url":"https://receiver.example.com/hook","secret":"whsec_super_secret"}',
      lastSyncAt: NOW,
      lastError: null,
      errorCount: 0,
      connectedAt: NOW,
      revokedAt: null,
    });

    assert.deepEqual(safe.configuredFields.sort(), ['secret', 'url']);
    const serialised = JSON.stringify(safe);
    assert.ok(!serialised.includes('whsec_super_secret'), 'a stored secret must not be echoed back');
    assert.ok(!serialised.includes('receiver.example.com'), 'config values stay server-side');
    assert.equal(safe.implemented, true);
  });

  it('marks an unknown provider as not implemented rather than crashing', () => {
    const safe = toSafeIntegration({
      id: 'int_2',
      provider: 'retired_provider',
      status: 'disconnected',
      displayName: '',
      config: '{}',
      lastSyncAt: null,
      lastError: null,
      errorCount: 0,
      connectedAt: null,
      revokedAt: NOW,
    });
    assert.equal(safe.implemented, false);
    assert.equal(safe.label, 'retired_provider');
  });
});

// ============================================================================
// Public API plumbing
// ============================================================================

describe('pagination parsing', () => {
  const urlWith = (query: string) => new URL(`https://x.test/api/v1/jobs${query}`);

  it('defaults to 25 rows from the start', () => {
    assert.deepEqual(parsePagination(urlWith('')), { limit: 25, offset: 0 });
  });

  it('accepts values inside the bounds', () => {
    assert.deepEqual(parsePagination(urlWith('?limit=100&offset=50')), { limit: 100, offset: 50 });
  });

  it('refuses an over-large limit instead of silently clamping it', () => {
    assert.throws(() => parsePagination(urlWith('?limit=1000')), /between 1 and 100/);
  });

  it('refuses a zero or negative limit', () => {
    assert.throws(() => parsePagination(urlWith('?limit=0')), /between 1 and 100/);
    assert.throws(() => parsePagination(urlWith('?offset=-1')), /between 0 and 100000/);
  });

  it('refuses a non-integer', () => {
    assert.throws(() => parsePagination(urlWith('?limit=abc')), /must be an integer/);
    assert.throws(() => parsePagination(urlWith('?limit=2.5')), /must be an integer/);
  });

  it('names the offending parameter so a client can point at it', () => {
    try {
      parsePagination(urlWith('?limit=1000'));
      assert.fail('expected a rejection');
    } catch (error) {
      assert.equal((error as { param?: string }).param, 'limit');
      assert.equal((error as { status?: number }).status, 400);
    }
  });

  it('treats an empty parameter as absent', () => {
    assert.deepEqual(parsePagination(urlWith('?limit=&offset=')), { limit: 25, offset: 0 });
  });
});

describe('parseEnumParam', () => {
  const url = new URL('https://x.test/api/v1/jobs?status=new&bad=nope');

  it('returns a permitted value', () => {
    assert.equal(parseEnumParam(url, 'status', ['new', 'applied'] as const), 'new');
  });

  it('returns undefined when absent', () => {
    assert.equal(parseEnumParam(url, 'missing', ['a'] as const), undefined);
  });

  it('rejects a value outside the set and lists what is allowed', () => {
    assert.throws(() => parseEnumParam(url, 'bad', ['a', 'b'] as const), /must be one of: a, b/);
  });
});

describe('parseBoundedInt', () => {
  it('uses the fallback for an absent value', () => {
    assert.equal(parseBoundedInt(null, { fallback: 7, min: 0, max: 10, param: 'n' }), 7);
    assert.equal(parseBoundedInt('  ', { fallback: 7, min: 0, max: 10, param: 'n' }), 7);
  });

  it('accepts the exact bounds', () => {
    assert.equal(parseBoundedInt('0', { fallback: 5, min: 0, max: 10, param: 'n' }), 0);
    assert.equal(parseBoundedInt('10', { fallback: 5, min: 0, max: 10, param: 'n' }), 10);
  });
});

describe('listEnvelope', () => {
  it('reports hasMore while rows remain', () => {
    const envelope = listEnvelope([1, 2], { limit: 2, offset: 0 }, 5);
    assert.equal(envelope.object, 'list');
    assert.equal(envelope.pagination.hasMore, true);
    assert.equal(envelope.pagination.total, 5);
  });

  it('reports hasMore false on the last page', () => {
    assert.equal(listEnvelope([1], { limit: 2, offset: 4 }, 5).pagination.hasMore, false);
  });

  it('reports hasMore false for an empty collection', () => {
    assert.equal(listEnvelope([], { limit: 25, offset: 0 }, 0).pagination.hasMore, false);
  });
});

describe('rateLimitHeaders', () => {
  beforeEach(() => resetRateLimits());

  it('publishes the limit, what is left, and when it resets', () => {
    const resetAt = new Date(NOW.getTime() + 60_000);
    const headers = rateLimitHeaders(
      { ok: true, remaining: 59, resetAt, retryAfterSeconds: 0 },
      60,
    );

    assert.equal(headers['X-RateLimit-Limit'], '60');
    assert.equal(headers['X-RateLimit-Remaining'], '59');
    assert.equal(headers['X-RateLimit-Reset'], String(Math.ceil(resetAt.getTime() / 1000)));
  });

  it('never publishes a negative remaining count', () => {
    const headers = rateLimitHeaders(
      { ok: false, remaining: -3, resetAt: NOW, retryAfterSeconds: 30 },
      60,
    );
    assert.equal(headers['X-RateLimit-Remaining'], '0');
  });
});

// ============================================================================
// Public resource shapes
// ============================================================================

describe('rateParts', () => {
  it('expresses a ratio in parts per million', () => {
    assert.equal(rateParts(1, 1), 1_000_000);
    assert.equal(rateParts(1, 2), 500_000);
    assert.equal(rateParts(1, 8), 125_000);
    assert.equal(rateParts(0, 10), 0);
  });

  it('returns zero rather than NaN for an empty denominator', () => {
    assert.equal(rateParts(0, 0), 0);
    assert.equal(rateParts(5, 0), 0);
  });

  it('always yields an integer', () => {
    for (let denominator = 1; denominator <= 97; denominator++) {
      const value = rateParts(1, denominator);
      assert.ok(Number.isInteger(value), `1/${denominator} produced ${value}`);
    }
  });
});

describe('serialiseApplication', () => {
  const row = {
    id: 'app_1',
    status: 'submitted',
    matchScore: 88,
    atsScore: 91,
    applyChannel: 'ats_api',
    atsVendor: 'greenhouse',
    confirmation: 'GH-123',
    failureReason: null,
    keywordsInjected: '["python","etl"]',
    agentId: 'agt_1',
    appliedAt: NOW,
    respondedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    // Fields that exist on the row but must not be published.
    job: {
      id: 'job_1',
      title: 'Data Analyst',
      company: 'Acme',
      location: 'Toronto, ON',
      country: 'CA',
      workMode: 'hybrid',
      jobType: 'full_time',
      salaryMin: 90_000,
      salaryMax: 110_000,
      salaryCurrency: 'CAD',
      source: 'adzuna',
      applyUrl: 'https://acme.test/jobs/1',
      postedAt: NOW,
    },
  };

  it('emits ISO-8601 strings for every date', () => {
    const serialised = serialiseApplication(row);
    assert.equal(serialised.appliedAt, NOW.toISOString());
    assert.equal(serialised.createdAt, NOW.toISOString());
    assert.equal(serialised.job.postedAt, NOW.toISOString());
    assert.equal(serialised.respondedAt, null);
  });

  it('parses the JSON string columns into arrays', () => {
    assert.deepEqual(serialiseApplication(row).keywordsInjected, ['python', 'etl']);
  });

  it('tags the object so a client can discriminate a mixed list', () => {
    assert.equal(serialiseApplication(row).object, 'application');
  });

  it('does not publish the tailored documents or the server file path', () => {
    const serialised = JSON.stringify(
      serialiseApplication({ ...row, keywordsInjected: '[]' }),
    );
    for (const forbidden of ['tailoredResume', 'coverLetter', 'folderPath', 'tailoringNotes']) {
      assert.ok(!serialised.includes(forbidden), `${forbidden} must stay private`);
    }
  });
});

describe('serialiseJobMatch', () => {
  const row = {
    id: 'mtc_1',
    agentId: 'agt_1',
    matchScore: 82,
    status: 'new',
    matchedKeywords: '["sql"]',
    missingKeywords: '["scala"]',
    rationale: 'Strong SQL overlap.',
    createdAt: NOW,
    agent: { name: 'Toronto analytics' },
    job: {
      id: 'job_1',
      title: 'Data Analyst',
      company: 'Acme',
      companyLogo: null,
      location: 'Toronto, ON',
      country: 'CA',
      workMode: 'hybrid',
      jobType: 'full_time',
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: 'CAD',
      source: 'adzuna',
      applyUrl: 'https://acme.test/jobs/1',
      applyMethod: 'external',
      skills: '["sql","python"]',
      requirements: '["3 years"]',
      nocCode: '21211',
      postedAt: NOW,
    },
  };

  it('publishes the job id at the top level and the match id underneath', () => {
    const serialised = serialiseJobMatch(row);
    assert.equal(serialised.id, 'job_1');
    assert.equal(serialised.match.id, 'mtc_1');
    assert.equal(serialised.match.agentName, 'Toronto analytics');
    assert.equal(serialised.match.score, 82);
  });

  it('parses every JSON column it publishes', () => {
    const serialised = serialiseJobMatch(row);
    assert.deepEqual(serialised.skills, ['sql', 'python']);
    assert.deepEqual(serialised.requirements, ['3 years']);
    assert.deepEqual(serialised.match.matchedKeywords, ['sql']);
    assert.deepEqual(serialised.match.missingKeywords, ['scala']);
  });

  it('omits the full posting description', () => {
    assert.ok(!('description' in serialiseJobMatch(row)));
  });

  it('survives malformed JSON in a column', () => {
    const broken = { ...row, job: { ...row.job, skills: 'not json' } };
    assert.deepEqual(serialiseJobMatch(broken).skills, []);
  });
});
