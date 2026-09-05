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
  // Provider secret shapes: Stripe (keys carry a live/test infix; a webhook
  // signing secret does not - Stage 23 review M6), AWS, Anthropic, GitHub, Slack, Google.
  [/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}\b/g, '[redacted-key]'],
  [/\bwhsec_[A-Za-z0-9]{8,}\b/g, '[redacted-key]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted-key]'],
  [/\bsk-ant-[A-Za-z0-9\-_]{12,}\b/g, '[redacted-key]'],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '[redacted-key]'],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g, '[redacted-key]'],
  [/\bAIza[0-9A-Za-z\-_]{30,}\b/g, '[redacted-key]'],
  // Our own API keys (Stage 14: `jp_` prefix).
  [/\bjp_[A-Za-z0-9_]{12,}\b/g, '[redacted-key]'],
  // A long hex blob (32+): a digest, an encryption key, a session id echoed by
  // a database error. A cuid is base36 and 25 characters, so it survives.
  [/\b[0-9a-f]{32,}\b/gi, '[redacted-hex]'],
  // A long base64 blob (40+ characters, letters AND digits): a generated
  // secret or a token. Words, paths with separators and short ids survive.
  [/(?<![A-Za-z0-9+/=])(?=[A-Za-z0-9+/]*\d)(?=[A-Za-z0-9+/]*[A-Za-z])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])/g, '[redacted-blob]'],
  // Email addresses.
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[redacted-email]'],
  // Phone numbers in the shapes people write them: an international prefix,
  // a bracketed area code, or 3-3-4 with separators. NOT any run of digits
  // (Stage 23 review L2): an invoice number, a ticket number or a timestamp
  // is what the person on call needs to read.
  [/(?<![\w/-])(?:\+\d[\d\s().-]{8,}\d|\(\d{3}\)\s?\d{3}[-.\s]?\d{4}|\b\d{3}[-.\s]\d{3}[-.\s]\d{4})(?![\w/])/g, '[redacted-number]'],
];

export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

export interface RedactedError {
  name: string;
  message: string;
  stack?: string;
  /** One level of `cause`, redacted the same way (Stage 23 review L3). */
  cause?: { name: string; message: string };
}

function safeString(value: unknown): string {
  try {
    return typeof value === 'string' ? value : String(value);
  } catch {
    return '[unprintable]';
  }
}

/**
 * What is safe to log about an error: its name, its redacted message, a
 * redacted stack and a redacted cause. Never the error object (it may carry
 * a request or a row). Never throws: a logger that throws inside a catch
 * block turns a handled error into an unhandled one.
 */
export function redactError(error: unknown): RedactedError {
  try {
    if (error instanceof Error) {
      let stack: string | undefined;
      try {
        stack = error.stack ? redact(error.stack) : undefined;
      } catch {
        stack = undefined;
      }
      const out: RedactedError = { name: safeString(error.name), message: redact(safeString(error.message)), stack };
      if (error.cause !== undefined && error.cause !== null) {
        const c = error.cause;
        out.cause = c instanceof Error ? { name: safeString(c.name), message: redact(safeString(c.message)) } : { name: 'cause', message: redact(safeString(c)) };
      }
      return out;
    }
    return { name: 'Error', message: redact(safeString(error)) };
  } catch {
    return { name: 'Error', message: '[unredactable error]' };
  }
}
