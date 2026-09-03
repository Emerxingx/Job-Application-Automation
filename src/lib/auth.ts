import { cookies } from 'next/headers';
import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';
import { db } from './db';
import { DEV_AUTH_SECRET, isUsableSecret } from './auth-policy';
import { recordSecurityEvent, type RequestMeta } from './security-audit';

const COOKIE_NAME = 'jobpilot_session';
const SESSION_DAYS = 30;
/** How stale `Session.lastSeenAt` may be before a request refreshes it. */
const LAST_SEEN_REFRESH_MS = 5 * 60 * 1000;

// Defined in ./auth-policy so src/proxy.ts can use them without pulling this
// module's Prisma and bcrypt imports into the edge runtime. Re-exported here so
// every existing caller and test is unaffected.
export { DEV_AUTH_SECRET, isUsableSecret } from './auth-policy';

/**
 * SESSIONS ARE SERVER-SIDE AND REVOCABLE (Stage 01, ADR-0004 §1)
 * --------------------------------------------------------------
 * Before Stage 01 the cookie was a bare 30-day JWT: logout deleted the cookie
 * and nothing else, so a stolen token stayed valid until it expired. Now the
 * JWT carries `sid`, the id of a `Session` row, and every authoritative check
 * (`getSessionUserId`, hence `requireUser`) loads that row and refuses it when
 * it is missing, revoked, expired, or older than the account's last password
 * change. Revocation is a single UPDATE and takes effect on the next request —
 * there is no cache in front of it, deliberately (ADR-0004: a cache that is not
 * invalidated synchronously makes revocation fictional).
 *
 * The edge gate (src/proxy.ts) still verifies only the signature. It cannot
 * reach the database; it exists to close forgotten routes, not to authorise.
 */

function secret(): Uint8Array {
  const value = process.env.AUTH_SECRET;
  if (!isUsableSecret(value)) {
    // Fail loudly in production rather than signing sessions with a weak or
    // publicly known key.
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'AUTH_SECRET must be set to a generated value of at least 32 characters in production. ' +
          'The placeholder from .env.example is not accepted — run: openssl rand -base64 32',
      );
    }
    return new TextEncoder().encode(DEV_AUTH_SECRET);
  }
  return new TextEncoder().encode(value);
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export type SessionMethod = 'password' | 'supabase';

export interface CreateSessionOptions {
  method?: SessionMethod;
  /** aal1 (single factor) or aal2 (MFA satisfied), in the provider's terms. */
  assuranceLevel?: 'aal1' | 'aal2';
  meta?: RequestMeta;
}

/**
 * Issue a session: a row, then a cookie naming it. The row is created first so
 * a cookie can never reference a session that does not exist.
 */
export async function createSession(userId: string, options: CreateSessionOptions = {}): Promise<string> {
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  const session = await db.session.create({
    data: {
      userId,
      method: options.method ?? 'password',
      assuranceLevel: options.assuranceLevel ?? 'aal1',
      expiresAt,
      ip: options.meta?.ip ?? null,
      userAgent: options.meta?.userAgent ?? null,
    },
    select: { id: true },
  });

  const token = await new SignJWT({ sub: userId, sid: session.id })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(secret());

  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
  return session.id;
}

/** The claims a valid cookie carries. `sid` is absent on pre-Stage-01 tokens. */
async function readCookieClaims(): Promise<{ sub: string; sid: string } | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
      // A signature-valid token without a session id predates server-side
      // sessions. It is not honoured: there is no row to revoke, so it would
      // be exactly the unrevocable credential Stage 01 removes.
      return null;
    }
    return { sub: payload.sub, sid: payload.sid };
  } catch {
    return null;
  }
}

/**
 * Whether a session row is currently valid for `userId`. Pure, so the
 * revocation rules are testable without a cookie jar.
 */
export function isSessionLive(
  session: { userId: string; revokedAt: Date | null; expiresAt: Date; createdAt: Date } | null,
  userId: string,
  passwordChangedAt: Date | null,
  now = new Date(),
): boolean {
  if (!session) return false;
  if (session.userId !== userId) return false;
  if (session.revokedAt !== null) return false;
  if (session.expiresAt <= now) return false;
  // A session issued before the password changed was issued to whoever knew
  // the OLD password. Belt and braces over the explicit revoke.
  if (passwordChangedAt && session.createdAt < passwordChangedAt) return false;
  return true;
}

/**
 * Resolve the signed-in user's id, or null. This is the authoritative check:
 * signature, then the session row, then the account's password epoch.
 */
export async function getSessionUserId(): Promise<string | null> {
  const claims = await readCookieClaims();
  if (!claims) return null;

  const session = await db.session.findUnique({
    where: { id: claims.sid },
    select: {
      id: true,
      userId: true,
      revokedAt: true,
      expiresAt: true,
      createdAt: true,
      lastSeenAt: true,
      user: { select: { passwordChangedAt: true } },
    },
  });
  if (!session || !isSessionLive(session, claims.sub, session.user.passwordChangedAt)) return null;

  if (Date.now() - session.lastSeenAt.getTime() > LAST_SEEN_REFRESH_MS) {
    // Best effort; the session list is the only reader and it tolerates lag.
    db.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
  }
  return session.userId;
}

/** The id of the current session row, or null. */
export async function getSessionId(): Promise<string | null> {
  const claims = await readCookieClaims();
  return claims?.sid ?? null;
}

/**
 * Sign out: revoke the current session row, THEN drop the cookie. The order
 * matters — if the cookie went first and the revoke failed, the token would
 * still be live for anyone who had copied it.
 */
export async function destroySession(meta?: RequestMeta): Promise<void> {
  const claims = await readCookieClaims();
  if (claims) {
    const revoked = await db.session.updateMany({
      where: { id: claims.sid, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'logout' },
    });
    if (revoked.count > 0) {
      const user = await db.user.findUnique({ where: { id: claims.sub }, select: { id: true, email: true, role: true } });
      if (user) {
        await recordSecurityEvent({ event: 'auth.logout', user, entityType: 'Session', entityId: claims.sid, summary: 'Signed out', meta });
      }
    }
  }
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

export type RevokeReason = 'logout' | 'password_change' | 'user_revoke' | 'staff_revoke';

/**
 * Revoke one session belonging to `userId`. Scoped by owner so a session id
 * guessed or leaked from another account cannot be revoked by a stranger — a
 * denial-of-service vector, if a small one.
 */
export async function revokeSession(userId: string, sessionId: string, reason: RevokeReason): Promise<boolean> {
  const result = await db.session.updateMany({
    where: { id: sessionId, userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  return result.count > 0;
}

/**
 * Revoke every live session of a user, optionally keeping one (the one the
 * user is acting from, so "sign out everywhere else" does not sign them out
 * too). Returns how many were revoked.
 */
export async function revokeAllSessions(
  userId: string,
  reason: RevokeReason,
  options: { except?: string | null } = {},
): Promise<number> {
  const result = await db.session.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(options.except ? { id: { not: options.except } } : {}),
    },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  return result.count;
}

/** The account holder's own live sessions, newest activity first. */
export async function listLiveSessions(userId: string) {
  return db.session.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true, method: true, assuranceLevel: true, createdAt: true, lastSeenAt: true, expiresAt: true, ip: true, userAgent: true },
    orderBy: { lastSeenAt: 'desc' },
  });
}

/** Load the signed-in user with subscription and plan, or null. */
export async function getCurrentUser() {
  const userId = await getSessionUserId();
  if (!userId) return null;

  return db.user.findUnique({
    where: { id: userId },
    include: { subscription: { include: { plan: true } } },
  });
}

export type CurrentUser = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;

/** Like getCurrentUser, but throws — for API routes that require auth. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

export class UnauthorizedError extends Error {
  constructor() {
    super('Authentication required');
    this.name = 'UnauthorizedError';
  }
}
