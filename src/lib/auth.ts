import { cookies } from 'next/headers';
import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';
import { db } from './db';
import { DEV_AUTH_SECRET, isUsableSecret } from './auth-policy';

const COOKIE_NAME = 'jobpilot_session';
const SESSION_DAYS = 30;

// Defined in ./auth-policy so src/middleware.ts can use them without pulling
// this module's Prisma and bcrypt imports into the edge runtime. Re-exported
// here so every existing caller and test is unaffected.
export { DEV_AUTH_SECRET, isUsableSecret } from './auth-policy';

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

export async function createSession(userId: string): Promise<void> {
  const token = await new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(secret());

  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

/** Resolve the signed-in user's id, or null. */
export async function getSessionUserId(): Promise<string | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, secret());
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
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
