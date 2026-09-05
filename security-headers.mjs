/**
 * Stage 23 (ADR-0037) - the response headers every route carries.
 *
 * Kept in a plain module at the repository root so that `next.config.mjs`
 * (which Next evaluates without TypeScript), the edge gate (`src/proxy.ts`)
 * and the static test (`tests/hardening-static.test.ts`) read the SAME
 * definitions; a header can be neither added to one nor dropped from the
 * other silently.
 *
 * What is and is not here, honestly:
 * - `Content-Security-Policy` is built PER REQUEST by the edge gate (Stage
 *   24, ADR-0038): the directives below that protect without a nonce (no
 *   framing by anyone, no plugins, no base-tag hijack, forms only to
 *   ourselves) plus a `script-src` that allows only scripts carrying that
 *   request's nonce (`'strict-dynamic'`, so the scripts they load are
 *   trusted too). Next.js reads the nonce from the request's own CSP header
 *   and stamps it on every script it emits. The policy is therefore NOT in
 *   the static list `next.config.mjs` ships - a static header cannot carry a
 *   per-request nonce - and lives in `contentSecurityPolicy()` below. In
 *   development Next needs `'unsafe-eval'` for its source maps; production
 *   never gets it.
 * - `Strict-Transport-Security` is inert over plain HTTP (a browser ignores
 *   it) and correct behind TLS; it is set unconditionally so a deployment
 *   cannot forget it. `includeSubDomains` means every subdomain of the
 *   deployed host must serve TLS too - deploy at a host whose subdomains you
 *   control, never at an apex that also serves plain-HTTP subdomains
 *   (Stage 23 review).
 * - `Cross-Origin-Opener-Policy: same-origin` would break a popup-based
 *   OAuth or payment SDK flow; none exists (the mailbox and SSO flows are
 *   redirects). Revisit if one is added.
 */
export const SECURITY_HEADERS = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
];

/** The directives that need no nonce: present on every response, whatever the request. */
export const CSP_BASE_DIRECTIVES = ["frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'"];

/**
 * The full policy for one request. `nonce` is 128 bits of randomness,
 * base64; `development` adds `'unsafe-eval'` for Next's dev tooling and
 * nothing else. `'self'` and `https:` are the fallback for browsers without
 * `'strict-dynamic'` support (they ignore the nonce-loaded-script rule);
 * a browser that understands `'strict-dynamic'` ignores those two.
 */
export function contentSecurityPolicy(nonce, development = false) {
  const scriptSrc = `script-src 'nonce-${nonce}' 'strict-dynamic' 'self' https:${development ? " 'unsafe-eval'" : ''}`;
  return [...CSP_BASE_DIRECTIVES, scriptSrc].join('; ');
}
