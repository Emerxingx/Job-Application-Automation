import { NextResponse, type NextRequest } from 'next/server';
import { jwtVerify } from 'jose';
import { DEV_AUTH_SECRET, isUsableSecret } from '@/lib/auth-policy';

/**
 * Global authentication gate — DENY BY DEFAULT.
 *
 * WHY THIS FILE IS CALLED `proxy` AND NOT `middleware`
 * ----------------------------------------------------
 * Next 16 renamed the convention: `middleware.ts` is deprecated and the build
 * warns about it. Verified against Next's own loader source rather than guessed
 * — `next/dist/build/webpack/loaders/next-middleware-loader.js` resolves the
 * handler as `(isProxy ? mod.proxy : mod.middleware) || mod.default`, and
 * `PROXY_FILENAME` is `proxy` matched at `(?:src/)?proxy`. So the file is
 * `src/proxy.ts`, the export is `proxy`, and the `config.matcher` export is
 * unchanged.
 *
 * This landed in the same stage as the Next 16 upgrade (ADR-0017) precisely so
 * a brand-new security-critical file does not ship on a deprecated convention.
 *
 * WHY THIS EXISTS
 * ---------------
 * Before Stage 01 there was no middleware. Every route re-implemented its own
 * `requireUser()`, which meant a new route was PUBLIC until someone remembered
 * to protect it — and nothing detected the omission. That is finding S-02 in
 * docs/programme/CURRENT_BASELINE.md, ranked HIGH precisely because the failure
 * is silent: the route works, it just works for everyone.
 *
 * So the default is inverted. Everything under this matcher requires a valid
 * session unless its prefix appears in PUBLIC_PREFIXES below. Adding a public
 * route is now a deliberate, reviewable edit to this file rather than an
 * accident of omission.
 *
 * THIS IS A GATE, NOT THE AUTHORISATION
 * -------------------------------------
 * Middleware runs on the edge and cannot reach the database, so it proves only
 * that the caller holds a correctly signed, unexpired session cookie. It does
 * NOT establish who they are for authorisation purposes, and it cannot honour
 * the server-side session revocation Stage 01 adds (a revoked token still has a
 * valid signature until it expires).
 *
 * Routes therefore keep calling `requireUser()`, and the staff console keeps its
 * two-lock gate. This is defence in depth: the cheap check runs first and
 * catches the forgotten route; the authoritative check still runs in the
 * handler. Removing either one is a regression.
 */

/**
 * Prefixes reachable WITHOUT a session cookie. Every entry needs a reason,
 * because every entry is a hole in the default.
 */
const PUBLIC_PREFIXES = [
  // Marketing landing page.
  '/',
  // Sign-in and registration, and the endpoints behind them. Excluding these
  // would make it impossible to ever obtain a session.
  '/login',
  '/signup',
  '/api/auth/login',
  '/api/auth/signup',
  // Logout must work even with an expired or malformed cookie, or a user can be
  // stuck holding a session they cannot clear.
  '/api/auth/logout',
  // Stripe authenticates by SIGNATURE, not by session, and must be reachable
  // unauthenticated. The route verifies the signature before trusting anything
  // and records the event before dispatching it.
  '/api/webhooks',
  // The public API authenticates with a bearer API key (SHA-256 hashed,
  // constant-time compared), not a session cookie. Gating it on a cookie would
  // break every server-to-server client.
  '/api/v1',
  // Payload CMS carries its own independent auth and its own editor identity
  // domain. Do not gate it on the application's session.
  '/admin',
  '/api/cms',
] as const;

/**
 * Whether a path is explicitly public.
 *
 * MATCHING IS PATH-SEGMENT AWARE, AND THAT IS A SECURITY PROPERTY, NOT A DETAIL.
 *
 * A naive `pathname.startsWith(prefix)` is wrong in a way that fails OPEN. With
 * `/admin` in the list, `startsWith` also matches `/administrative-reports`, so
 * a future route whose name merely begins with a public prefix would be served
 * to anonymous callers. The same holds for `/login` vs `/login-as`, and
 * `/api/v1` vs `/api/v10`. This was caught by the lookalike-prefix test below,
 * and the test stays because the mistake is easy to reintroduce.
 *
 * A prefix therefore matches only the path itself or a path continuing at a
 * segment boundary: `/admin` matches `/admin` and `/admin/anything`, never
 * `/administrative-reports`.
 */
export function isPublicPath(pathname: string): boolean {
  for (const prefix of PUBLIC_PREFIXES) {
    if (prefix === '/') {
      // The root would otherwise prefix-match the entire site.
      if (pathname === '/') return true;
      continue;
    }
    if (pathname === prefix) return true;
    if (pathname.startsWith(prefix + '/')) return true;
  }
  return false;
}

function secret(): Uint8Array {
  const value = process.env.AUTH_SECRET;
  // Mirrors src/lib/auth.ts exactly: the published placeholder is rejected BY
  // VALUE, so a deployment that copied .env.example cannot validate sessions.
  if (!isUsableSecret(value)) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('AUTH_SECRET must be set to a generated value of at least 32 characters.');
    }
    return new TextEncoder().encode(DEV_AUTH_SECRET);
  }
  return new TextEncoder().encode(value);
}

async function hasValidSession(request: NextRequest): Promise<boolean> {
  const token = request.cookies.get('jobpilot_session')?.value;
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, secret());
    return typeof payload.sub === 'string' && payload.sub.length > 0;
  } catch {
    // Expired, tampered, or signed with a different key. All are "no session".
    return false;
  }
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublicPath(pathname)) return NextResponse.next();

  if (await hasValidSession(request)) return NextResponse.next();

  // An unauthenticated API call gets a JSON 401 — a redirect would be parsed as
  // a success by a fetch() caller and surface as a confusing parse error.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  }

  const login = new URL('/login', request.url);
  // Preserve the destination so sign-in can return the user where they meant to
  // go. Only the path and query are carried, never an absolute URL, so this
  // cannot be turned into an open redirect.
  login.searchParams.set('next', pathname + request.nextUrl.search);
  return NextResponse.redirect(login);
}

export const config = {
  /**
   * Everything except Next internals and static files. Those carry no
   * authorisation meaning and gating them would cost latency on every asset.
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)'],
};
