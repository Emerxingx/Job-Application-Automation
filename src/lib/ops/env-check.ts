import { isUsableSecret } from '@/lib/auth-policy';
import { isUsablePayloadSecret } from '@/lib/cms-secret';
import { describeDatabaseUrl, normalizeDatabaseUrl } from '@/lib/db-url';
import { RESIDENCY_REGIONS } from '@/lib/storage/s3';
import { rateLimitStoreName } from '@/lib/rate-limit';

/**
 * Stage 24 (ADR-0038) - the production configuration check:
 * `npm run env:check`, the first step of every deploy.
 *
 * It answers "is this environment shaped like production?" and prints
 * NOTHING that is a value: not a URL, not a key, not an address. Every
 * finding is a name, a status and a sentence. The rules are the production
 * rules whatever NODE_ENV says, because the point is to run it against the
 * production configuration before that configuration serves anyone; a
 * NODE_ENV that is not `production` is itself a finding.
 *
 * Pure over an env object so the test can feed it shapes without setting
 * anything on the process.
 */

export type EnvStatus = 'PASS' | 'FAIL' | 'WARN';

export interface EnvFinding {
  name: string;
  status: EnvStatus;
  detail: string;
}

export interface EnvReport {
  findings: EnvFinding[];
  /** No FAIL. */
  ok: boolean;
}

const present = (v: string | undefined): v is string => typeof v === 'string' && v.trim().length > 0;

function roleAndDatabase(raw: string | undefined): { user: string; database: string; host: string } | null {
  const normalized = normalizeDatabaseUrl(raw);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    return { user: url.username, database: url.pathname.replace(/^\//, ''), host: url.hostname };
  } catch {
    return null;
  }
}

function keyBytes(value: string): number | null {
  const v = value.trim();
  if (/^[0-9a-fA-F]+$/.test(v) && v.length % 2 === 0) return v.length / 2;
  try {
    const buf = Buffer.from(v, 'base64');
    return buf.length > 0 && buf.toString('base64').replace(/=+$/, '') === v.replace(/=+$/, '') ? buf.length : null;
  } catch {
    return null;
  }
}

export function checkEnvironment(env: NodeJS.ProcessEnv): EnvReport {
  const f: EnvFinding[] = [];
  const add = (name: string, status: EnvStatus, detail: string) => f.push({ name, status, detail });

  add('NODE_ENV', env.NODE_ENV === 'production' ? 'PASS' : 'FAIL', env.NODE_ENV === 'production' ? 'production' : 'not "production": the server-start guards for the secrets and the app URL do not fire');

  // --- secrets -------------------------------------------------------------
  const auth = isUsableSecret(env.AUTH_SECRET);
  add('AUTH_SECRET', auth ? 'PASS' : 'FAIL', auth ? 'generated value of 32+ characters' : 'missing, short, or the published placeholder (refused by value at start)');
  const payload = isUsablePayloadSecret(env.PAYLOAD_SECRET);
  add('PAYLOAD_SECRET', payload ? 'PASS' : 'FAIL', payload ? 'generated value of 32+ characters' : 'missing, short, or the published placeholder');
  if (auth && payload) add('AUTH_SECRET ≠ PAYLOAD_SECRET', env.AUTH_SECRET !== env.PAYLOAD_SECRET ? 'PASS' : 'FAIL', env.AUTH_SECRET !== env.PAYLOAD_SECRET ? 'distinct' : 'the same value signs both editor and job-seeker sessions');
  for (const name of ['MAILBOX_ENCRYPTION_KEY', 'SSO_ENCRYPTION_KEY'] as const) {
    const v = env[name];
    if (!present(v)) {
      add(name, 'WARN', 'absent: the feature that needs it (mailbox connections / SSO) refuses to save a secret until it is set');
      continue;
    }
    const bytes = keyBytes(v);
    add(name, bytes === 32 ? 'PASS' : 'FAIL', bytes === 32 ? '32 bytes' : 'not 32 random bytes in base64 or hex');
  }
  if (present(env.MAILBOX_ENCRYPTION_KEY) && present(env.SSO_ENCRYPTION_KEY)) {
    add('MAILBOX_ENCRYPTION_KEY ≠ SSO_ENCRYPTION_KEY', env.MAILBOX_ENCRYPTION_KEY !== env.SSO_ENCRYPTION_KEY ? 'PASS' : 'FAIL', env.MAILBOX_ENCRYPTION_KEY !== env.SSO_ENCRYPTION_KEY ? 'distinct' : 'one key, one blast radius: they must differ');
  }

  // --- origin and proxies ----------------------------------------------------
  const appUrl = env.NEXT_PUBLIC_APP_URL?.trim();
  if (!present(appUrl)) add('NEXT_PUBLIC_APP_URL', 'FAIL', 'missing: production refuses to start; every signed link is built from it');
  else {
    let parsed: URL | null = null;
    try {
      parsed = new URL(appUrl);
    } catch {
      parsed = null;
    }
    if (!parsed) add('NEXT_PUBLIC_APP_URL', 'FAIL', 'not a URL');
    else if (parsed.protocol !== 'https:') add('NEXT_PUBLIC_APP_URL', 'FAIL', 'not https: cookies are Secure in production and HSTS is sent');
    else if (/^(localhost|127\.|0\.0\.0\.0)/.test(parsed.hostname)) add('NEXT_PUBLIC_APP_URL', 'FAIL', 'a loopback origin');
    else if (appUrl.endsWith('/') || parsed.pathname !== '/' || parsed.search) add('NEXT_PUBLIC_APP_URL', 'WARN', 'carries a path, query or trailing slash; the origin alone is expected');
    else add('NEXT_PUBLIC_APP_URL', 'PASS', 'an https origin');
  }
  const hops = env.TRUSTED_PROXY_HOPS;
  if (!present(hops)) add('TRUSTED_PROXY_HOPS', 'WARN', 'unset: defaults to 1 (one load balancer); set it to match the host');
  else if (!/^\d+$/.test(hops.trim())) add('TRUSTED_PROXY_HOPS', 'FAIL', 'not a whole number');
  else add('TRUSTED_PROXY_HOPS', 'PASS', `${hops.trim()} trusted hop(s)`);

  // --- database ----------------------------------------------------------------
  const runtime = describeDatabaseUrl(env.DATABASE_URL);
  const direct = describeDatabaseUrl(env.DIRECT_URL);
  if (!runtime) add('DATABASE_URL', 'FAIL', 'missing or not a connection URL');
  else add('DATABASE_URL', runtime.mode === 'transaction-pooler' ? 'PASS' : 'WARN', runtime.mode === 'transaction-pooler' ? 'transaction-mode pooler (port and pgbouncer parameter)' : `mode "${runtime.mode}": the application expects the transaction pooler`);
  if (!direct) add('DIRECT_URL', 'FAIL', 'missing or not a connection URL: migrations, backups and the worker need the session endpoint');
  else add('DIRECT_URL', direct.mode === 'session-pooler-or-direct' ? 'PASS' : 'FAIL', direct.mode === 'session-pooler-or-direct' ? 'session endpoint' : `mode "${direct.mode}": migrations cannot run through the transaction pooler`);
  const r = roleAndDatabase(env.DATABASE_URL);
  const d = roleAndDatabase(env.DIRECT_URL);
  if (r && d) {
    add('DATABASE_URL and DIRECT_URL role', r.user === d.user ? 'PASS' : 'FAIL', r.user === d.user ? 'the same role (the RLS system policy is bound to it)' : 'different roles: the application role would have no policy on any forced table and see nothing');
    add('DATABASE_URL and DIRECT_URL database', r.database === d.database ? 'PASS' : 'FAIL', r.database === d.database ? 'the same database' : 'different databases');
  }
  const cms = env.PAYLOAD_DATABASE_URI?.trim();
  if (!present(cms)) add('PAYLOAD_DATABASE_URI', 'FAIL', 'missing');
  else if (cms.startsWith('file:')) add('PAYLOAD_DATABASE_URI', 'FAIL', 'a SQLite file: local only; production uses a separate PostgreSQL database');
  else if (!/^postgres(ql)?:\/\//.test(cms)) add('PAYLOAD_DATABASE_URI', 'FAIL', 'not a PostgreSQL URL');
  else {
    const c = roleAndDatabase(cms);
    if (c && r && c.database === r.database && c.host === r.host) add('PAYLOAD_DATABASE_URI', 'FAIL', 'the same database as DATABASE_URL: the CMS must have its own logical database');
    else add('PAYLOAD_DATABASE_URI', 'PASS', 'a separate PostgreSQL database');
  }

  // --- storage (ADR-0015) --------------------------------------------------------
  const storage = (env.STORAGE_PROVIDER || 'local').toLowerCase();
  if (storage === 's3') {
    const missing = ['STORAGE_S3_ENDPOINT', 'STORAGE_S3_REGION', 'STORAGE_S3_BUCKET', 'STORAGE_S3_ACCESS_KEY_ID', 'STORAGE_S3_SECRET_ACCESS_KEY'].filter((n) => !present(env[n]));
    if (missing.length > 0) add('STORAGE_PROVIDER=s3', 'FAIL', `incomplete (${missing.join(', ')} unset): the app would fall back to the local disk`);
    else if (!RESIDENCY_REGIONS.includes(env.STORAGE_S3_REGION!.trim())) add('STORAGE_S3_REGION', 'FAIL', `outside the residency allow-list (${RESIDENCY_REGIONS.join(', ')}); the provider refuses to start`);
    else add('STORAGE_PROVIDER=s3', 'PASS', `complete, region ${env.STORAGE_S3_REGION!.trim()}`);
  } else if (storage === 'local') add('STORAGE_PROVIDER', 'WARN', 'local disk: documents live on this host only; needs a persistent volume and its own backup');
  else add('STORAGE_PROVIDER', 'FAIL', 'not "local" or "s3"');

  // --- staff, connectors, providers ------------------------------------------
  const staff = env.STAFF_EMAILS?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
  if (staff.length === 0) add('STAFF_EMAILS', 'WARN', 'unset: the console denies everyone (safe, and nobody can operate it)');
  else if (staff.some((s) => s.toLowerCase() === 'demo@jobpilot.ai')) add('STAFF_EMAILS', 'FAIL', 'names the seeded demo account, whose password is published');
  else if (staff.some((s) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s))) add('STAFF_EMAILS', 'FAIL', 'an entry is not an email address');
  else add('STAFF_EMAILS', 'PASS', `${staff.length} staff address(es)`);
  if ((env.MAILBOX_CONNECTOR ?? '').trim().toLowerCase() === 'mock') add('MAILBOX_CONNECTOR', 'FAIL', '"mock" is refused in production');
  else add('MAILBOX_CONNECTOR', 'PASS', present(env.MAILBOX_CONNECTOR) ? 'a real connector is named (its OAuth client must be configured)' : 'unset: no mailbox connector offered');
  const jobProvider = (env.JOB_PROVIDER || 'mock').toLowerCase();
  add('JOB_PROVIDER', jobProvider === 'mock' ? 'WARN' : 'PASS', jobProvider === 'mock' ? 'the synthetic mock source: fine for a rehearsal, not for customers' : `names "${jobProvider}"; it must also be enabled at /console/sources`);
  if ((env.PAYMENT_PROVIDER || 'mock').toLowerCase() === 'stripe') {
    const missing = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'].filter((n) => !present(env[n]));
    add('PAYMENT_PROVIDER=stripe', missing.length === 0 ? 'PASS' : 'FAIL', missing.length === 0 ? 'key and webhook secret present (never validated live from this codebase)' : `${missing.join(', ')} unset`);
  } else add('PAYMENT_PROVIDER', 'WARN', 'mock: checkout is simulated');
  if ((env.AI_PROVIDER || 'mock').toLowerCase() === 'anthropic') add('AI_PROVIDER=anthropic', present(env.ANTHROPIC_API_KEY) ? 'PASS' : 'FAIL', present(env.ANTHROPIC_API_KEY) ? 'key present; a task is served by a model only once a prompt version is promoted' : 'ANTHROPIC_API_KEY unset');
  else add('AI_PROVIDER', 'WARN', 'mock: every task is served by the deterministic engine');

  // --- scale (R-16) ----------------------------------------------------------
  const store = env.RATE_LIMIT_STORE?.trim().toLowerCase();
  if (store && store !== 'memory' && store !== 'postgres') add('RATE_LIMIT_STORE', 'FAIL', 'not "memory" or "postgres"');
  else add('RATE_LIMIT_STORE', rateLimitStoreName(env) === 'postgres' ? 'PASS' : 'WARN', rateLimitStoreName(env) === 'postgres' ? 'shared (PostgreSQL)' : 'in-process: correct for ONE instance; set "postgres" before a second');
  add('REDIS_URL', present(env.REDIS_URL) ? 'PASS' : 'WARN', present(env.REDIS_URL) ? 'shared cache configured (ioredis must be installed)' : 'unset: in-process cache, not shared across instances');

  return { findings: f, ok: f.every((x) => x.status !== 'FAIL') };
}
