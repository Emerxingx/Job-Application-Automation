/**
 * Credentials for the public API (`/api/v1/*`).
 *
 * WHY NOT BCRYPT, WHEN PASSWORDS USE BCRYPT
 * -----------------------------------------
 * `src/lib/auth.ts` hashes passwords with bcrypt at cost 10, and that is
 * correct there: a human-chosen password has maybe 30 bits of entropy, so the
 * only defence against an offline dictionary attack is to make each guess
 * expensive. An API key is not a password. It is 256 bits drawn from
 * `crypto.randomBytes`, so there is no dictionary, no reuse across sites, and
 * no guess worth making — 2^256 candidates does not become feasible because
 * each one got cheaper.
 *
 * Two properties of this system make bcrypt actively WRONG here, not merely
 * unnecessary:
 *
 *   1. `ApiKey.keyHash` carries `@unique` in the schema. bcrypt embeds a random
 *      salt, so hashing one key twice yields two different strings — a unique
 *      index over bcrypt output constrains nothing at all, and the duplicate it
 *      is meant to catch sails straight through.
 *   2. The key is verified on EVERY public API request. bcrypt at cost 10 is
 *      roughly 100 ms of CPU by design. That is a self-inflicted denial of
 *      service on a rate-limited endpoint: an attacker sending garbage keys
 *      costs us 100 ms of CPU per request while costing themselves nothing.
 *
 * So: SHA-256, deterministic, of the whole raw key. This is what GitHub and
 * Stripe do with their tokens and for the same reason. The security property
 * that actually matters is preserved and is the one this module enforces
 * everywhere below: THE RAW KEY IS NEVER PERSISTED, NEVER LOGGED, AND NEVER
 * RETURNED AGAIN AFTER CREATION. A stolen database yields hashes of 256-bit
 * random strings, which is to say it yields nothing.
 *
 * WHY NOT PEPPER THE HASH WITH AUTH_SECRET
 * ----------------------------------------
 * Tempting, and it would add a little defence-in-depth against an attacker
 * holding a database dump who wants to confirm a key they already have. But
 * rotating AUTH_SECRET would silently invalidate every customer's API key at
 * once, and this codebase has no key-rotation story (the schema notes as much
 * about `Integration.accessToken`). Coupling every integration's liveness to a
 * secret that operators are told to rotate buys a marginal property at the cost
 * of an outage nobody would predict. Not worth it.
 *
 * KEY FORMAT
 * ----------
 *     jp_live_8f3a2b1c_a4f1…  (64 more hex characters)
 *     └──── prefix ────┘└──── secret ────┘
 *
 * The prefix is stored in the clear, is `@unique`, and is what we show in the
 * UI and index the lookup on. It identifies WHICH key is being presented; the
 * secret proves possession of it. Both halves are hex, deliberately: base64url
 * contains `_`, which would make the boundary between prefix and secret
 * ambiguous to parse.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { db } from '../db';
import { parseJson } from '../types';

// --- Format -----------------------------------------------------------------

export type ApiKeyEnvironment = 'live' | 'test';

/** Bytes of randomness in the secret half. 32 bytes = 256 bits. */
const SECRET_BYTES = 32;
/** Bytes of randomness in the prefix's discriminator. */
const PREFIX_BYTES = 4;

/**
 * `jp_live_8f3a2b1c_<64 hex>`. Anchored at both ends and fully case-sensitive:
 * a key that differs only in case is a different key, and accepting it would
 * mean the constant-time compare below is comparing normalised inputs rather
 * than what the caller actually sent.
 */
const KEY_PATTERN = /^(jp_(live|test)_[0-9a-f]{8})_([0-9a-f]{64})$/;

export interface ParsedApiKey {
  /** The public, displayable handle — `jp_live_8f3a2b1c`. */
  prefix: string;
  environment: ApiKeyEnvironment;
  /** The secret half. Never store this. */
  secret: string;
  /** The full key exactly as presented. Never store this either. */
  raw: string;
}

/**
 * Split a presented key into its parts, or null when it is not one of ours.
 *
 * Returning null for a malformed key rather than throwing matters: this runs on
 * unauthenticated input on every public API request, and a thrown error there
 * is a 500 where the honest answer is 401.
 */
export function parseApiKey(raw: string | null | undefined): ParsedApiKey | null {
  if (typeof raw !== 'string') return null;
  const candidate = raw.trim();
  const match = KEY_PATTERN.exec(candidate);
  if (!match) return null;
  return {
    prefix: match[1],
    environment: match[2] as ApiKeyEnvironment,
    secret: match[3],
    raw: candidate,
  };
}

/**
 * The stored hash for a raw key. Hashes the WHOLE key, prefix included, so a
 * secret is cryptographically bound to the prefix it was issued with — pairing
 * one key's prefix with another's secret produces a hash that matches neither.
 */
export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** Mint a new key. The raw value in the result is the only copy that will exist. */
export function generateApiKey(environment: ApiKeyEnvironment = 'live'): {
  raw: string;
  prefix: string;
  keyHash: string;
  environment: ApiKeyEnvironment;
} {
  const prefix = `jp_${environment}_${randomBytes(PREFIX_BYTES).toString('hex')}`;
  const secret = randomBytes(SECRET_BYTES).toString('hex');
  const raw = `${prefix}_${secret}`;
  return { raw, prefix, keyHash: hashApiKey(raw), environment };
}

/**
 * Constant-time string comparison.
 *
 * `timingSafeEqual` throws on length mismatch, which would itself leak length
 * through an exception, so unequal lengths short-circuit to false first. For
 * our fixed-length hex digests the lengths are always equal in the honest case,
 * so this branch only fires on corrupt data.
 */
export function secureEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Display form for a key we can no longer show in full: `jp_live_8f3a2b1c…`. */
export function maskApiKey(prefix: string): string {
  return `${prefix}…`;
}

// --- Scopes -----------------------------------------------------------------

/**
 * The scope vocabulary, matching the set named in `prisma/schema.prisma`.
 * Adding a value here is a public API change — clients store the strings.
 */
export const API_SCOPES = [
  'admin',
  'write',
  'read',
  'apply:write',
  'scan:read',
  'match:score',
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

/**
 * DIRECT grants only; `expandScopes` takes the transitive closure.
 *
 * The ladder is `admin > write > read > {scan:read, match:score}`, with
 * `write` additionally granting `apply:write`. Two decisions worth stating:
 *
 *   - `write` implies `read`. A client that may create an application may
 *     certainly list the applications it created; forcing callers to request
 *     both is friction that teaches people to just ask for `admin`.
 *   - `admin` is NOT merely "all of the above" — it is also the scope that
 *     gates key and webhook management. It is listed as granting `write` so
 *     that adding a future scope under `write` does not silently withhold it
 *     from admins.
 */
const SCOPE_GRANTS: Record<ApiScope, readonly ApiScope[]> = {
  admin: ['write'],
  write: ['read', 'apply:write'],
  read: ['scan:read', 'match:score'],
  'apply:write': [],
  'scan:read': [],
  'match:score': [],
};

export function isApiScope(value: unknown): value is ApiScope {
  return typeof value === 'string' && (API_SCOPES as readonly string[]).includes(value);
}

/**
 * Read the `scopes` JSON column into a validated list.
 *
 * Unknown strings are DROPPED rather than kept. A scope name we no longer
 * recognise cannot be evaluated, and carrying it forward as an opaque token
 * means a future rename could resurrect a permission nobody granted.
 */
export function parseScopes(value: string | null | undefined): ApiScope[] {
  const raw = parseJson<unknown[]>(value, []);
  if (!Array.isArray(raw)) return [];
  const seen = new Set<ApiScope>();
  for (const entry of raw) if (isApiScope(entry)) seen.add(entry);
  return [...seen];
}

/** Serialise scopes back to the JSON string column. */
export function serialiseScopes(scopes: readonly ApiScope[]): string {
  return JSON.stringify([...new Set(scopes)]);
}

/** Everything `granted` confers, following `SCOPE_GRANTS` to a fixed point. */
export function expandScopes(granted: readonly ApiScope[]): Set<ApiScope> {
  const effective = new Set<ApiScope>();
  const queue = [...granted];
  while (queue.length > 0) {
    const scope = queue.pop()!;
    if (effective.has(scope)) continue;
    effective.add(scope);
    for (const implied of SCOPE_GRANTS[scope]) queue.push(implied);
  }
  return effective;
}

/** Whether a key holding `granted` may perform an action requiring `required`. */
export function hasScope(granted: readonly ApiScope[], required: ApiScope): boolean {
  return expandScopes(granted).has(required);
}

// --- Authentication ---------------------------------------------------------

/** The columns authentication needs. Narrowed so tests need no Prisma. */
export interface ApiKeyRecord {
  id: string;
  userId: string | null;
  organizationId: string | null;
  name: string;
  prefix: string;
  keyHash: string;
  scopes: string;
  environment: string;
  rateLimitPerMinute: number;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

/** A key that passed every check, with its scopes already parsed. */
export interface AuthenticatedApiKey {
  id: string;
  userId: string;
  organizationId: string | null;
  name: string;
  prefix: string;
  environment: ApiKeyEnvironment;
  scopes: ApiScope[];
  rateLimitPerMinute: number;
}

export type ApiKeyDenialReason =
  | 'missing'
  | 'malformed'
  | 'unknown'
  | 'revoked'
  | 'expired'
  | 'orphaned'
  | 'insufficient_scope';

export type ApiKeyAuthentication =
  | { ok: true; key: AuthenticatedApiKey }
  | { ok: false; reason: ApiKeyDenialReason; status: number; message: string };

/** The one lookup authentication performs. */
export interface ApiKeyStore {
  findByPrefix(prefix: string): Promise<ApiKeyRecord | null>;
}

/** Adapt Prisma to `ApiKeyStore`. */
export function prismaApiKeyStore(): ApiKeyStore {
  return {
    findByPrefix: (prefix) => db.apiKey.findUnique({ where: { prefix } }),
  };
}

/**
 * Verify a presented key.
 *
 * Every denial except `insufficient_scope` answers 401 with the SAME message.
 * Distinguishing "no such key" from "revoked key" would confirm to a prober
 * that a prefix they hold was once real, which is a free oracle over the key
 * space. Scope failure is different and deliberately 403 with a specific
 * message: the caller has already proved they hold a valid key, so telling
 * them which scope they lack is help, not leakage.
 */
export async function authenticateApiKey(
  store: ApiKeyStore,
  presented: string | null | undefined,
  options: { now?: Date; requiredScope?: ApiScope } = {},
): Promise<ApiKeyAuthentication> {
  const now = options.now ?? new Date();
  const deny = (reason: ApiKeyDenialReason): ApiKeyAuthentication => ({
    ok: false,
    reason,
    status: 401,
    message: 'Invalid or expired API key.',
  });

  if (presented === null || presented === undefined || presented.trim() === '') {
    return {
      ok: false,
      reason: 'missing',
      status: 401,
      message:
        'Missing API key. Send it as `Authorization: Bearer jp_live_…` or in the `X-API-Key` header.',
    };
  }

  const parsed = parseApiKey(presented);
  if (!parsed) return deny('malformed');

  const record = await store.findByPrefix(parsed.prefix);
  if (!record) return deny('unknown');

  // Compare hashes, not secrets: both sides are then fixed-length hex derived
  // from the input, so the compare tells an attacker nothing about the stored
  // value even before `secureEquals` makes its duration uniform.
  if (!secureEquals(hashApiKey(parsed.raw), record.keyHash)) return deny('unknown');

  if (record.revokedAt !== null && record.revokedAt <= now) return deny('revoked');
  if (record.expiresAt !== null && record.expiresAt <= now) return deny('expired');

  // `ApiKey.userId` is nullable in the schema so an organization can own a key
  // directly. Nothing issues those yet, and the v1 endpoints all scope their
  // reads by user id, so a key with no user must not authenticate — returning
  // an unscoped reader would expose every row in the table.
  if (!record.userId) return deny('orphaned');

  const scopes = parseScopes(record.scopes);
  const key: AuthenticatedApiKey = {
    id: record.id,
    userId: record.userId,
    organizationId: record.organizationId,
    name: record.name,
    prefix: record.prefix,
    environment: record.environment === 'test' ? 'test' : 'live',
    scopes,
    rateLimitPerMinute: record.rateLimitPerMinute,
  };

  if (options.requiredScope && !hasScope(scopes, options.requiredScope)) {
    return {
      ok: false,
      reason: 'insufficient_scope',
      status: 403,
      message: `This API key is missing the \`${options.requiredScope}\` scope.`,
    };
  }

  return { ok: true, key };
}

/**
 * Pull the credential out of a request.
 *
 * `Authorization: Bearer …` is the standard and is what the docs show;
 * `X-API-Key` is accepted because a surprising number of no-code HTTP clients
 * cannot set an Authorization header. Bearer wins when both are present, so a
 * stale `X-API-Key` in a saved request cannot quietly override the credential
 * the caller actually meant to use.
 */
export function extractApiKey(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match) return match[1].trim();
  }
  const header = request.headers.get('x-api-key');
  return header ? header.trim() : null;
}

// --- Management -------------------------------------------------------------

/** Everything about a key that is safe to hand back to its owner. */
export interface SafeApiKey {
  id: string;
  name: string;
  prefix: string;
  masked: string;
  environment: string;
  scopes: ApiScope[];
  rateLimitPerMinute: number;
  requestCount: number;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  revoked: boolean;
  createdAt: Date;
}

/**
 * Project a stored row to its safe shape.
 *
 * The parameter type lists `keyHash` and then never reads it. That is on
 * purpose: it means you can pass a full Prisma row straight in, and the one
 * place that could leak the hash is this function, where its absence from the
 * output is visible in a dozen lines rather than spread across every route.
 */
export function toSafeApiKey(
  row: ApiKeyRecord & { requestCount: number; lastUsedAt: Date | null; createdAt: Date },
  now: Date = new Date(),
): SafeApiKey {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    masked: maskApiKey(row.prefix),
    environment: row.environment,
    scopes: parseScopes(row.scopes),
    rateLimitPerMinute: row.rateLimitPerMinute,
    requestCount: row.requestCount,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    revoked: row.revokedAt !== null && row.revokedAt <= now,
    createdAt: row.createdAt,
  };
}

/** Ceiling on live keys per user, so a runaway script cannot mint thousands. */
export const MAX_ACTIVE_KEYS_PER_USER = 20;

/** Default per-key request budget, in requests per minute. */
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;

export interface CreateApiKeyInput {
  name: string;
  scopes?: ApiScope[];
  environment?: ApiKeyEnvironment;
  rateLimitPerMinute?: number;
  expiresAt?: Date | null;
}

/**
 * Issue a key.
 *
 * The raw value is returned exactly once, here. Nothing writes it anywhere —
 * not the row, not a log line, not the audit trail — so if the caller loses it
 * the only recovery is to issue another one. That is the intended behaviour and
 * the route says so to the user.
 */
export async function createApiKey(
  userId: string,
  input: CreateApiKeyInput,
): Promise<{ key: SafeApiKey; secret: string }> {
  // Integration keys only: a device key (Stage 14) is a session, capped and
  // recycled by src/lib/integrations/device-sessions.ts, and must not be able
  // to lock the owner out of minting a server key by filling this budget.
  const active = await db.apiKey.count({ where: { userId, kind: 'integration', revokedAt: null } });
  if (active >= MAX_ACTIVE_KEYS_PER_USER) {
    throw new Error(
      `You already have ${MAX_ACTIVE_KEYS_PER_USER} active API keys. Revoke one before creating another.`,
    );
  }

  const environment = input.environment ?? 'live';
  const generated = generateApiKey(environment);
  const scopes = input.scopes && input.scopes.length > 0 ? input.scopes : (['read'] as ApiScope[]);

  const row = await db.apiKey.create({
    data: {
      userId,
      name: input.name,
      prefix: generated.prefix,
      keyHash: generated.keyHash,
      scopes: serialiseScopes(scopes),
      environment,
      kind: 'integration',
      rateLimitPerMinute: input.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE,
      expiresAt: input.expiresAt ?? null,
    },
  });

  return { key: toSafeApiKey(row), secret: generated.raw };
}

/** A user's keys, newest first, in their safe shape. */
export async function listApiKeys(userId: string): Promise<SafeApiKey[]> {
  // Device keys are listed with the sessions (they are sign-ins, not integrations).
  const rows = await db.apiKey.findMany({ where: { userId, kind: 'integration' }, orderBy: { createdAt: 'desc' } });
  const now = new Date();
  return rows.map((row) => toSafeApiKey(row, now));
}

/**
 * Revoke a key. Idempotent — revoking an already-revoked key keeps the original
 * timestamp, because the moment access actually stopped is the auditable fact.
 */
export async function revokeApiKey(
  userId: string,
  keyId: string,
): Promise<SafeApiKey | null> {
  const existing = await db.apiKey.findFirst({ where: { id: keyId, userId } });
  if (!existing) return null;
  if (existing.revokedAt) return toSafeApiKey(existing);

  const row = await db.apiKey.update({
    where: { id: keyId },
    data: { revokedAt: new Date() },
  });
  return toSafeApiKey(row);
}

/**
 * Stamp usage after a successful authenticated call.
 *
 * Deliberately swallows its own errors. This is bookkeeping on the hot path; a
 * lock wait or a transient connection error must not turn a perfectly good 200
 * into a 500. The counter is advisory, the request already happened.
 */
export async function recordApiKeyUse(keyId: string, ip: string | null): Promise<void> {
  try {
    await db.apiKey.update({
      where: { id: keyId },
      data: {
        lastUsedAt: new Date(),
        lastUsedIp: ip ?? null,
        requestCount: { increment: 1 },
      },
    });
  } catch (error) {
    console.warn('[api-keys] could not record usage:', error);
  }
}
