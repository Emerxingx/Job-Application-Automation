import { NextResponse, type NextRequest } from 'next/server';
import { jwtVerify } from 'jose';
import { DEV_AUTH_SECRET, isUsableSecret } from '@/lib/auth-policy';
import { contentSecurityPolicy } from '../security-headers.mjs';

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
  // The documents the signup consent refers to must be readable before an
  // account exists, or the consent is not informed.
  '/terms',
  '/privacy',
  '/api/auth/login',
  '/api/auth/signup',
  // Exchanges a verified identity-provider token for a platform session; by
  // definition the caller has no session yet. The route verifies the token's
  // signature, issuer and audience before trusting a single claim.
  '/api/auth/exchange',
  // Stage 20 (ADR-0035): enterprise sign-in. `start` routes an address to its
  // organisation's identity provider (no session yet, by definition) and
  // `callback` is where that provider sends the browser back; both verify
  // everything they receive (a signed state cookie, the provider's signed ID
  // token) before trusting a single claim.
  '/api/auth/sso',
  // SCIM provisioning authenticates with a bearer token issued by staff for
  // ONE organisation (SHA-256 digest, constant-time compare), never a cookie:
  // the caller is an identity provider, not a person.
  '/api/scim',
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
  // Stage 23: the health check a load balancer reads; rate-limited by address and says nothing sensitive.
  '/api/health',
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

/** Methods a browser sends without a preflight and that change state: the CSRF surface. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Prefixes authenticated by a bearer credential rather than the cookie, which a cross-site page cannot attach - no CSRF surface. */
const BEARER_PREFIXES = ['/api/v1', '/api/scim', '/api/webhooks'];

/**
 * Stage 23 (ADR-0037) - CSRF: is this a state-changing request that a
 * cross-site page made with the victim's cookie? `sameSite: lax` on the
 * cookie already blocks the classic cross-site POST in current browsers; this
 * is the second, explicit check (readiness gate G2 "CSRF: tokens on
 * state-changing routes" was PARTIAL) so the defence does not rest on one
 * cookie attribute. The browser's own `Sec-Fetch-Site` is authoritative when
 * present; an `Origin` that names another host is refused; a request with
 * neither header (an old browser, a non-browser client with the cookie) is
 * allowed, because a cross-site attacker cannot strip `Origin` from a
 * browser-made request. Pure, so the static test can enumerate the cases.
 */
export function isCrossSiteWrite(method: string, headers: { get(name: string): string | null }, host: string | null, pathname: string): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  if (BEARER_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'))) return false;
  const fetchSite = headers.get('sec-fetch-site');
  // Stage 23 review (L7): `same-site` is a SIBLING origin (another subdomain);
  // with HSTS `includeSubDomains` there will be some, and none of them may
  // write here with the cookie. Only our own origin, or a navigation the
  // user typed (`none`), passes.
  if (fetchSite) return !(fetchSite === 'same-origin' || fetchSite === 'none');
  const origin = headers.get('origin');
  if (!origin || !host) return false;
  try {
    return new URL(origin).host.toLowerCase() !== host.toLowerCase();
  } catch {
    return true;
  }
}

/**
 * Stage 24 (ADR-0038) - a per-request Content-Security-Policy with a script
 * nonce. The nonce is 128 random bits; the policy goes on the REQUEST (so
 * Next stamps the nonce on every script it emits for this render) and on
 * the RESPONSE (so the browser enforces it). Every response this gate
 * returns carries it - the page, a redirect, a 401, a 403 - because a
 * static header cannot hold a per-request value. The edge runtime has Web
 * Crypto and no Buffer, hence the manual base64.
 */
function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function withCsp(response: NextResponse, csp: string): NextResponse {
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const nonce = newNonce();
  const csp = contentSecurityPolicy(nonce, process.env.NODE_ENV !== 'production');
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('Content-Security-Policy', csp);
  requestHeaders.set('x-nonce', nonce);
  const next = () => withCsp(NextResponse.next({ request: { headers: requestHeaders } }), csp);

  // A cross-site write carrying the session cookie is refused before anything
  // else looks at it - the cookie is the only thing an attacker's page can
  // borrow, so the check applies only when it is present.
  // The CMS's own cookie (`payload-token`) is a credential a cross-site page
  // can borrow just the same, so the check covers both (Stage 23 review, L7).
  // The comparison is against `Host`, not a forwarded host header: a
  // forwarded header is client-writable when no proxy sets it, and comparing
  // Origin against it would let an attacker satisfy the check with two
  // headers of their own choosing.
  if ((request.cookies.get('jobpilot_session') || request.cookies.get('payload-token')) && isCrossSiteWrite(request.method, request.headers, request.headers.get('host'), pathname)) {
    return withCsp(NextResponse.json({ error: 'Cross-site request refused.' }, { status: 403 }), csp);
  }

  if (isPublicPath(pathname)) return next();

  if (await hasValidSession(request)) return next();

  // An unauthenticated API call gets a JSON 401 — a redirect would be parsed as
  // a success by a fetch() caller and surface as a confusing parse error.
  if (pathname.startsWith('/api/')) {
    return withCsp(NextResponse.json({ error: 'Authentication required.' }, { status: 401 }), csp);
  }

  const login = new URL('/login', request.url);
  // Preserve the destination so sign-in can return the user where they meant to
  // go. Only the path and query are carried, never an absolute URL, so this
  // cannot be turned into an open redirect.
  login.searchParams.set('next', pathname + request.nextUrl.search);
  return withCsp(NextResponse.redirect(login), csp);
}

export const config = {
  /**
   * Everything except Next internals and static files. Those carry no
   * authorisation meaning and gating them would cost latency on every asset.
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)'],
};
