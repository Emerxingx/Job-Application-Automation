/**
 * Stage 23 (ADR-0037) - log redaction.
 *
 * The readiness gate "log PII redaction" was NOT VERIFIED: an unhandled error
 * was logged whole, and an error's message can carry an email address (a
 * unique-constraint failure names the value), a bearer token or an API key
 * (a provider's own error echoes the request), a session JWT, or a
 * connection string with its password. Every server-side log line of an
 * error goes through `redactError` so none of those reaches a log store,
 * where retention is longer and access wider than the database's.
 *
 * Pure and deliberately conservative: it replaces what it recognises and
 * leaves the rest of the message intact, because a log line that says only
 * "[redacted]" is useless to the person on call.
 */
const PATTERNS: [RegExp, string][] = [
  // Connection strings: keep the scheme and host, drop the credentials.
  [/\b([a-z][a-z0-9+.-]*):\/\/[^\s/:@]+:[^\s/@]+@/gi, '$1://[redacted]@'],
  // Bearer / basic credentials in headers echoed into messages.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*/g, '$1 [redacted]'],
  // JWTs: three base64url segments.
  [/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted-jwt]'],
  // Provider secret shapes: Stripe, AWS, Anthropic, GitHub, Slack, Google.
  [/\b(sk|pk|rk|whsec)_(live|test)_[A-Za-z0-9]{8,}\b/g, '[redacted-key]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted-key]'],
  [/\bsk-ant-[A-Za-z0-9\-_]{12,}\b/g, '[redacted-key]'],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '[redacted-key]'],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g, '[redacted-key]'],
  [/\bAIza[0-9A-Za-z\-_]{30,}\b/g, '[redacted-key]'],
  // Our own API keys (Stage 14: `jp_` prefix) and any long hex/base64 blob that looks like a secret.
  [/\bjp_[A-Za-z0-9_]{12,}\b/g, '[redacted-key]'],
  // Email addresses.
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[redacted-email]'],
  // Phone numbers with 10+ digits in the usual shapes.
  [/(?<![\w/])\+?\d[\d\s().-]{8,}\d(?![\w/])/g, '[redacted-number]'],
];

export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** What is safe to log about an error: its name, its redacted message, and a redacted stack. Never the error object (it may carry a request or a row). */
export function redactError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return { name: error.name, message: redact(error.message), stack: error.stack ? redact(error.stack) : undefined };
  }
  return { name: 'Error', message: redact(typeof error === 'string' ? error : String(error)) };
}
