/**
 * Stage 14 (ADR-0013, ADR-0028 v1.1) - device sessions: how the mobile app
 * signs in without a cookie.
 *
 * The frozen contract authenticates with a bearer API key, so the app holds
 * one. It is minted here by the applicant's own sign-in (their password, or a
 * Supabase Auth token - the same two methods the web accepts, ADR-0004), as an
 * `ApiKey` row of kind `device`: the same table, the same hash-only storage,
 * the same authentication checks, revocation and per-key budget as an
 * integration key, plus what a session needs -
 *
 *   - it expires (DEVICE_SESSION_DAYS) rather than living until revoked;
 *   - the owner sees and revokes each device (the sessions page, the app);
 *   - a password change and "sign out everywhere else" revoke every device
 *     key with the web sessions, so a stolen phone is cut off the same way a
 *     stolen cookie is;
 *   - a cap per user, recycling the least-recently-used device rather than
 *     refusing the sign-in - a new phone must be able to sign in;
 *   - it never carries `admin`: `write` is the most an app holds, so a device
 *     key can do exactly what the applicant can do on the web and nothing a
 *     staff member can (no console, no key minting - a key cannot mint a key).
 *
 * The raw key is returned once, to the device, which keeps it in the
 * platform's secure storage (Keychain / Keystore; never AsyncStorage,
 * MOBILE_ARCHITECTURE.md). Nothing here writes it anywhere else.
 */
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { sessionTtlSeconds, verifyPassword } from '@/lib/auth';
import { passwordSignInRefusal, sessionMaxHoursFor } from '@/lib/sso/service';
import type { ConsentPurpose } from '@/lib/consent';
import { IdentityLinkError, linkSupabaseIdentity } from '@/lib/identity/link';
import {
  fetchSupabaseUser,
  SupabaseIdentityError,
  supabaseIdentityConfig,
  verifySupabaseAccessToken,
  withProviderVerification,
} from '@/lib/identity/supabase';
import { LIMITS, rateLimit } from '@/lib/rate-limit';
import { hashEmail, recordSecurityEvent, type RequestMeta } from '@/lib/security-audit';
import { generateApiKey, serialiseScopes, type ApiScope } from './api-keys';
import { ApiRequestError } from './http';

export const DEVICE_PLATFORMS = ['ios', 'android', 'web', 'other'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

/** A device signs in again after this; the web session is 30 days, a phone is kept longer because it is unlocked by the platform. */
export const DEVICE_SESSION_DAYS = 90;
/** Devices per account; the least recently used is recycled beyond this. */
export const MAX_DEVICES_PER_USER = 10;
/** A phone refreshes several screens at once; twice the integration default. */
export const DEVICE_RATE_LIMIT_PER_MINUTE = 120;
/** `write` expands to read + apply:write (api-keys.ts): the candidate surface, never admin. */
export const DEVICE_SCOPES: readonly ApiScope[] = ['write'];

export interface DeviceSession {
  object: 'device_session';
  id: string;
  name: string;
  platform: DevicePlatform;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  /** True for the key that made the request. */
  current: boolean;
}

type DeviceRow = {
  id: string;
  name: string;
  platform: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
};

export function isDevicePlatform(value: unknown): value is DevicePlatform {
  return typeof value === 'string' && (DEVICE_PLATFORMS as readonly string[]).includes(value);
}

export function serialiseDevice(row: DeviceRow, currentKeyId: string | null): DeviceSession {
  return {
    object: 'device_session',
    id: row.id,
    name: row.name,
    platform: isDevicePlatform(row.platform) ? row.platform : 'other',
    prefix: row.prefix,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    current: row.id === currentKeyId,
  };
}

export type DeviceSignIn =
  | { method: 'password'; email: string; password: string }
  | { method: 'supabase'; accessToken: string; fullName?: string; consents?: ConsentPurpose[] };

export interface DeviceDescriptor {
  name: string;
  platform: DevicePlatform;
}

const NOT_RECOGNISED = 'That email and password combination is not recognized.';

/**
 * Authenticate the applicant and mint their device key. Every refusal is the
 * v1 envelope (ApiRequestError): 401 for a credential that does not verify,
 * 503 when the deployment has no identity provider, the link's own status
 * for an identity that cannot be linked. Failures are audited against the
 * digest of the address, never the address (as the web sign-in does).
 */
export async function issueDeviceSession(
  signIn: DeviceSignIn,
  device: DeviceDescriptor,
  meta: RequestMeta,
): Promise<{ token: string; session: DeviceSession; user: { id: string; email: string; onboarded: boolean } }> {
  let user: { id: string; email: string; role: string; onboardedAt: Date | null };
  let assuranceLevel: 'aal1' | 'aal2' = 'aal1';

  if (signIn.method === 'password') {
    const email = signIn.email.toLowerCase().trim();
    // Budgeted per account as well as per address: the address is only as
    // trustworthy as the proxy in front (rate-limit.ts), the account is not.
    const budget = await rateLimit('auth_account', hashEmail(email), LIMITS.authAccount);
    if (!budget.ok) throw new ApiRequestError('rate_limited', 'Too many sign-in attempts for this account. Try again later.', 429);
    const found = await db.user.findUnique({ where: { email }, select: { id: true, email: true, role: true, onboardedAt: true, passwordHash: true } });
    if (!found || !(await verifyPassword(signIn.password, found.passwordHash))) {
      await recordSecurityEvent({
        event: 'auth.login.failed',
        actor: { type: 'system' },
        entityType: 'User',
        entityId: found?.id ?? '',
        summary: 'Device sign-in failed',
        detail: { emailHash: hashEmail(email), accountExists: found !== null, platform: device.platform },
        meta,
      });
      throw new ApiRequestError('unauthorized', NOT_RECOGNISED, 401);
    }
    user = found;
  } else {
    const config = supabaseIdentityConfig();
    if (!config) throw new ApiRequestError('unavailable', 'Identity-provider sign-in is not configured on this deployment.', 503);
    let identity;
    try {
      identity = await verifySupabaseAccessToken(signIn.accessToken, config);
      identity = withProviderVerification(identity, await fetchSupabaseUser(signIn.accessToken, config));
    } catch (error) {
      if (error instanceof SupabaseIdentityError) {
        await recordSecurityEvent({
          event: 'auth.login.failed',
          actor: { type: 'system' },
          summary: 'Device sign-in: identity-provider token rejected',
          detail: { provider: 'supabase', reason: error.message, platform: device.platform },
          meta,
        });
        throw new ApiRequestError('unauthorized', 'That sign-in token is not valid.', 401);
      }
      throw error;
    }
    try {
      const linked = await linkSupabaseIdentity(identity, { consents: signIn.consents, fullName: signIn.fullName, meta });
      user = linked.user;
      assuranceLevel = identity.assuranceLevel;
    } catch (error) {
      if (error instanceof IdentityLinkError) throw new ApiRequestError('invalid_request', error.message, error.status);
      throw error;
    }
  }

  // Stage 20 review (H2): the device door honours the organisation's
  // policies as the web doors do - `requireSso` refuses the password and
  // identity-provider methods for the organisation's members, checked AFTER
  // the credential so the refusal reveals nothing; the session ceiling caps
  // the key's life.
  const ssoRequired = await passwordSignInRefusal(user.email);
  if (ssoRequired) throw new ApiRequestError('unauthorized', ssoRequired, 403);
  const generated = generateApiKey('live');
  const ceilingHours = await sessionMaxHoursFor(user.id);
  const expiresAt = new Date(Date.now() + (ceilingHours ? Math.min(DEVICE_SESSION_DAYS * 24 * 60 * 60, sessionTtlSeconds(ceilingHours)) : DEVICE_SESSION_DAYS * 24 * 60 * 60) * 1000);
  // Recycle and create under one advisory lock per account, so two sign-ins
  // racing cannot both see room for one more device (Stage 14 review).
  const row = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`device:${user.id}`}::text))`;
    await recycleDevices(tx, user.id, meta);
    return tx.apiKey.create({
      data: {
        userId: user.id,
        name: device.name,
        kind: 'device',
        platform: device.platform,
        prefix: generated.prefix,
        keyHash: generated.keyHash,
        scopes: serialiseScopes(DEVICE_SCOPES),
        environment: 'live',
        rateLimitPerMinute: DEVICE_RATE_LIMIT_PER_MINUTE,
        expiresAt,
      },
    });
  });
  await recordSecurityEvent({
    event: 'auth.device.issued',
    user,
    entityType: 'ApiKey',
    entityId: row.id,
    summary: 'Signed in on a device',
    detail: { method: signIn.method, platform: device.platform, assuranceLevel, expiresAt: expiresAt.toISOString() },
    meta,
  });
  await recordSecurityEvent({
    event: 'auth.login.succeeded',
    user,
    entityType: 'ApiKey',
    entityId: row.id,
    summary: 'Signed in (device)',
    detail: { method: signIn.method, surface: 'mobile', assuranceLevel },
    meta,
  });

  return {
    token: generated.raw,
    session: serialiseDevice(row, row.id),
    user: { id: user.id, email: user.email, onboarded: user.onboardedAt !== null },
  };
}

/** Beyond the cap, revoke the least recently used devices so the new one fits. */
async function recycleDevices(client: Prisma.TransactionClient | typeof db, userId: string, meta: RequestMeta): Promise<void> {
  const active = await client.apiKey.findMany({
    where: { userId, kind: 'device', revokedAt: null },
    orderBy: [{ lastUsedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
    select: { id: true },
  });
  const excess = active.length - (MAX_DEVICES_PER_USER - 1);
  if (excess <= 0) return;
  const victims = active.slice(0, excess).map((k) => k.id);
  await client.apiKey.updateMany({ where: { id: { in: victims }, userId }, data: { revokedAt: new Date() } });
  await recordSecurityEvent(
    {
    event: 'auth.device.revoked',
    user: { id: userId, email: '' },
    actor: { type: 'system' },
    entityType: 'ApiKey',
    entityId: victims.join(','),
    summary: `Recycled ${victims.length} least-recently-used device${victims.length === 1 ? '' : 's'} (cap ${MAX_DEVICES_PER_USER})`,
    detail: { revoked: victims.length, reason: 'device_cap' },
    meta,
    },
    client,
  );
}

/** The owner's live devices, most recently used first. */
export async function listDeviceSessions(userId: string, currentKeyId: string | null): Promise<DeviceSession[]> {
  const rows = await db.apiKey.findMany({
    where: { userId, kind: 'device', revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    orderBy: [{ lastUsedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    select: { id: true, name: true, platform: true, prefix: true, createdAt: true, lastUsedAt: true, expiresAt: true },
  });
  return rows.map((r) => serialiseDevice(r, currentKeyId));
}

export type DeviceRevokeReason = 'logout' | 'user_revoke' | 'password_change' | 'sign_out_everywhere' | 'staff_revoke' | 'account_erasure';

/**
 * Revoke one device, scoped by owner (a stranger's guess at an id revokes
 * nothing). Idempotent: an already-revoked device keeps its timestamp.
 */
export async function revokeDeviceSession(
  user: { id: string; email: string },
  keyId: string,
  reason: DeviceRevokeReason,
  meta: RequestMeta,
): Promise<boolean> {
  const existing = await db.apiKey.findFirst({ where: { id: keyId, userId: user.id, kind: 'device' }, select: { id: true, revokedAt: true, platform: true } });
  if (!existing) return false;
  if (existing.revokedAt === null) {
    await db.apiKey.update({ where: { id: keyId }, data: { revokedAt: new Date() } });
  }
  await recordSecurityEvent({
    event: 'auth.device.revoked',
    user,
    entityType: 'ApiKey',
    entityId: keyId,
    summary: reason === 'logout' ? 'Signed out on a device' : 'Device signed out',
    detail: { reason, platform: existing.platform, alreadyRevoked: existing.revokedAt !== null },
    meta,
  });
  return true;
}

/** Every live device key of the user, optionally keeping one. Returns how many were revoked. */
export async function revokeAllDeviceSessions(
  userId: string,
  reason: DeviceRevokeReason,
  options: { except?: string | null } = {},
): Promise<number> {
  const result = await db.apiKey.updateMany({
    where: { userId, kind: 'device', revokedAt: null, ...(options.except ? { id: { not: options.except } } : {}) },
    data: { revokedAt: new Date() },
  });
  void reason;
  return result.count;
}
