/**
 * Connection-string normalisation, with NO dependencies.
 *
 * WHY THIS EXISTS
 * ---------------
 * Supabase issues database passwords that can contain URL-reserved characters,
 * and it hands out connection strings with the password pasted in verbatim.
 * Node's `URL`, `pg-connection-string` and Prisma's query engine all parse the
 * string as a URL, so a reserved character in the password either throws
 * ("Invalid URL") or, worse, is silently read as a delimiter and produces a
 * wrong host or database name. Stage 01 hit the first of those against the
 * real staging credential.
 *
 * The fix is to percent-encode the password exactly once. This function is
 * idempotent: a password that is already encoded is left alone, so the same
 * value can pass through here more than once without being double-encoded.
 *
 * It never logs, throws with, or otherwise surfaces the credential. Callers
 * that need to describe a connection use `describeDatabaseUrl`, which returns
 * the redacted host, port and connection mode and nothing else.
 */

// The password runs from the first ':' after the user to the LAST '@': a
// password may itself contain '@' (Supabase has issued such), and the host
// part never does, so the split is unambiguous only when anchored at the end.
const URL_SHAPE = /^([a-z][a-z0-9+.-]*):\/\/([^:/@]*)(?::(.*))?@([^@]*)$/i;

/** Whether every `%` in the value already begins a valid escape sequence. */
function isAlreadyEncoded(password: string): boolean {
  if (!/%/.test(password)) return false;
  if (!/^(?:[A-Za-z0-9\-._~]|%[0-9A-Fa-f]{2})*$/.test(password)) return false;
  try {
    decodeURIComponent(password);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the connection string with its password percent-encoded so that URL
 * parsers read it correctly. Non-URL values (SQLite `file:` paths, empty
 * strings) are returned unchanged.
 */
export function normalizeDatabaseUrl(raw: string | undefined): string | undefined {
  if (!raw) return raw;
  const match = raw.match(URL_SHAPE);
  if (!match) return raw;
  const [, scheme, user, password, rest] = match;
  if (password === undefined || password === '') return raw;
  if (isAlreadyEncoded(password)) return raw;
  return `${scheme}://${user}:${encodeURIComponent(password)}@${rest}`;
}

export interface DatabaseUrlDescription {
  scheme: string;
  /** Hostname with any project-identifying label shortened. */
  host: string;
  port: number | null;
  database: string | null;
  /** From the port and query string, never from the credential. */
  mode: 'transaction-pooler' | 'session-pooler-or-direct' | 'unknown';
  pgbouncer: boolean;
}

/**
 * A redacted description safe to print in logs, evidence and diagnostics. The
 * user and password are never included; the host keeps only its region-bearing
 * prefix so a project reference cannot be read back out of it.
 */
export function describeDatabaseUrl(raw: string | undefined): DatabaseUrlDescription | null {
  const normalized = normalizeDatabaseUrl(raw);
  if (!normalized) return null;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return null;
  }
  const port = url.port ? Number(url.port) : null;
  const pgbouncer = url.searchParams.get('pgbouncer') === 'true';
  const host = url.hostname.replace(/^([a-z0-9-]*-[a-z]{2}-[a-z]+-\d)[a-z0-9-]*/i, '$1');
  return {
    scheme: url.protocol.replace(/:$/, ''),
    host,
    port,
    database: url.pathname.replace(/^\//, '') || null,
    mode:
      port === 6543 || pgbouncer
        ? 'transaction-pooler'
        : port === 5432
          ? 'session-pooler-or-direct'
          : 'unknown',
    pgbouncer,
  };
}
