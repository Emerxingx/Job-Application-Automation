import { cookies } from 'next/headers';
import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';
import { db } from './db';
import { DEV_AUTH_SECRET, isUsableSecret } from './auth-policy';
import { recordSecurityEvent, type RequestMeta } from './security-audit';

const COOKIE_NAME = 'jobpilot_session';
const SESSION_DAYS = 30;
/** Stage 20 (ADR-0035): the second cookie a staff member holds while impersonating; see impersonation below. */
const IMPERSONATION_COOKIE = 'jobpilot_impersonation';
export const IMPERSONATION_MAX_MINUTES = 60;
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

/** The session signing secret, for other server-side signatures (Stage 09 document links). Never exposed. */
export function signingSecret(): Uint8Array {
  return secret();
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export type SessionMethod = 'password' | 'supabase' | 'sso';

export interface CreateSessionOptions {
  method?: SessionMethod;
  /** aal1 (single factor) or aal2 (MFA satisfied), in the provider's terms. */
  assuranceLevel?: 'aal1' | 'aal2';
  meta?: RequestMeta;
  /** Stage 20: an organisation's session ceiling (hours); the platform's 30 days otherwise. Never lengthens. */
  maxHours?: number | null;
}

/**
 * Issue a session: a row, then a cookie naming it. The row is created first so
 * a cookie can never reference a session that does not exist.
 */
export async function createSession(userId: string, options: CreateSessionOptions = {}): Promise<string> {
  const ttlSeconds = sessionTtlSeconds(options.maxHours);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
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
    maxAge: ttlSeconds,
  });
  return session.id;
}

/** The platform default, shortened (never lengthened) by an organisation's `sessionMaxHours` policy. Pure. */
export function sessionTtlSeconds(maxHours: number | null | undefined): number {
  const platform = SESSION_DAYS * 24 * 60 * 60;
  if (typeof maxHours !== 'number' || !Number.isFinite(maxHours) || maxHours <= 0) return platform;
  return Math.min(platform, Math.round(maxHours * 60 * 60));
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
 * IMPERSONATION (Stage 20, ADR-0035) - read-only, reason-required, time-boxed.
 *
 * A staff member impersonating a customer holds TWO cookies: their own session
 * (unchanged, still the authority on who they are) and a signed impersonation
 * token naming an `ImpersonationSession` row, the target, and the staff
 * session it was minted under. While that token is live every authoritative
 * read answers with the TARGET's id, so pages render as the customer sees
 * them; `route()` refuses every non-GET request, so nothing is written. Live
 * means: the row exists, was not ended, is inside its window, and the staff
 * member's own session is still live - revoking the staff session ends the
 * impersonation with it. No `Session` row is ever issued for the target (the
 * `staff_impersonation` method stays reserved and unissued): the
 * ImpersonationSession row IS the session, and ending it is one update.
 */
export interface ImpersonationClaims {
  impersonationId: string;
  userId: string;
  staffId: string;
  staffSessionId: string;
}

export async function mintImpersonationToken(input: ImpersonationClaims & { expiresAt: Date }): Promise<string> {
  return new SignJWT({ sub: input.userId, imp: input.impersonationId, staff: input.staffId, ssid: input.staffSessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(input.expiresAt)
    .sign(secret());
}

/** Pure liveness of an impersonation row given the staff member's own session state. */
export function isImpersonationLive(
  row: { userId: string; staffId: string; readOnly: boolean; startedAt: Date; endedAt: Date | null } | null,
  claims: ImpersonationClaims,
  staffSessionLive: boolean,
  now = new Date(),
): boolean {
  if (!row) return false;
  if (row.userId !== claims.userId || row.staffId !== claims.staffId) return false;
  if (!row.readOnly) return false;
  if (row.endedAt !== null) return false;
  if (row.startedAt.getTime() + IMPERSONATION_MAX_MINUTES * 60_000 <= now.getTime()) return false;
  return staffSessionLive;
}

export interface CurrentImpersonation extends ImpersonationClaims {
  staffEmail: string;
  endsAt: Date;
  reason: string;
}

async function readImpersonationClaims(): Promise<ImpersonationClaims | null> {
  let token: string | undefined;
  try {
    token = (await cookies()).get(IMPERSONATION_COOKIE)?.value;
  } catch {
    // Outside a request scope (a script, a test calling a handler directly)
    // there is no cookie jar and therefore no impersonation.
    return null;
  }
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    if (typeof payload.sub !== 'string' || typeof payload.imp !== 'string' || typeof payload.staff !== 'string' || typeof payload.ssid !== 'string') return null;
    return { userId: payload.sub, impersonationId: payload.imp, staffId: payload.staff, staffSessionId: payload.ssid };
  } catch {
    return null;
  }
}

/** The live impersonation this request runs under, or null. Checked against the row and the staff session on every call - no cache. */
export async function currentImpersonation(): Promise<CurrentImpersonation | null> {
  const claims = await readImpersonationClaims();
  if (!claims) return null;
  const [row, staffSession] = await Promise.all([
    db.impersonationSession.findUnique({ where: { id: claims.impersonationId }, select: { userId: true, staffId: true, staffEmail: true, readOnly: true, startedAt: true, endedAt: true, reason: true } }),
    db.session.findUnique({ where: { id: claims.staffSessionId }, select: { userId: true, revokedAt: true, expiresAt: true, createdAt: true, user: { select: { passwordChangedAt: true } } } }),
  ]);
  const staffLive = staffSession !== null && isSessionLive(staffSession, claims.staffId, staffSession.user.passwordChangedAt);
  if (!isImpersonationLive(row, claims, staffLive)) return null;
  return { ...claims, staffEmail: row!.staffEmail, endsAt: new Date(row!.startedAt.getTime() + IMPERSONATION_MAX_MINUTES * 60_000), reason: row!.reason };
}

export async function setImpersonationCookie(token: string, expiresAt: Date): Promise<void> {
  const store = await cookies();
  store.set(IMPERSONATION_COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', expires: expiresAt });
}

export async function clearImpersonationCookie(): Promise<void> {
  const store = await cookies();
  store.delete(IMPERSONATION_COOKIE);
}

/**
 * Resolve the signed-in user's id, or null. This is the authoritative check:
 * signature, then the session row, then the account's password epoch. Under a
 * live impersonation the answer is the target's id (see above).
 */
export async function getSessionUserId(): Promise<string | null> {
  const impersonation = await currentImpersonation();
  if (impersonation) return impersonation.userId;
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
