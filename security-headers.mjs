/**
 * Stage 23 (ADR-0037) - the response headers every route carries.
 *
 * Kept in a plain module at the repository root so that `next.config.mjs`
 * (which Next evaluates without TypeScript) and the static test
 * (`tests/hardening-static.test.ts`) read the SAME list; a header can be
 * neither added to one nor dropped from the other silently.
 *
 * What is and is not here, honestly:
 * - `Content-Security-Policy` carries the directives that protect without a
 *   nonce: no framing by anyone, no plugins, no base-tag hijack, forms only to
 *   ourselves. There is deliberately NO `script-src`: Next's own inline
 *   bootstrap needs a per-request nonce (or hashes) to survive a strict
 *   script policy, and Payload's admin bundle has its own requirements. That
 *   is Stage 24 work with the CDN in front, and the readiness gate says
 *   PARTIAL until it lands rather than shipping a policy the app violates.
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
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
];
