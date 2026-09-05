/**
 * The deployment's own public origin, for any absolute URL the server hands
 * out that must be trusted later (a signed document link, a checkout return,
 * an invoice link). NEVER the request's Host: that header is whatever the
 * client or an untrusted proxy sent, and a signed query string attached to an
 * attacker-chosen authority is a replayable credential (Stage 14 review).
 * Production refuses to run without it; development falls back to localhost.
 */
export function appUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, '');
  if (configured) return configured;
  if (env.NODE_ENV === 'production') throw new Error('NEXT_PUBLIC_APP_URL must be set in production.');
  return 'http://localhost:3000';
}
