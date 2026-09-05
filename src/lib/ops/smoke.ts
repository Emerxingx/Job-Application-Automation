import { CSP_BASE_DIRECTIVES, SECURITY_HEADERS } from '../../../security-headers.mjs';

/**
 * Stage 24 (ADR-0038) - the production smoke suite: `npm run smoke -- <origin>`.
 *
 * Run against a DEPLOYED origin after every deploy (and by the rollback
 * runbook after a rollback). Every check is something an anonymous client
 * can observe, so the suite needs no credential and can never leak one: the
 * health words, the security headers, the deny-by-default gate, the two
 * error envelopes, the CSRF refusal, the CMS being up, and that an unknown
 * route is a 404 and not a stack trace. It proves the deploy is SERVING and
 * SAFE; it does not prove the product works (that is the accessibility run
 * over the signed-in pages in CI, and the contract suite).
 *
 * Pure over `fetch`, so the test drives it with a fake and the script with
 * the real one.
 */

export interface SmokeCheck {
  name: string;
  ok: boolean;
  detail: string;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 10_000;

async function get(fetchImpl: Fetch, url: string, init: RequestInit = {}): Promise<Response | null> {
  try {
    return await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), ...init });
  } catch {
    return null;
  }
}

export async function runSmoke(origin: string, fetchImpl: Fetch = fetch): Promise<SmokeCheck[]> {
  const base = origin.replace(/\/+$/, '');
  const checks: SmokeCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  // 1. Health: serving, and the words are the fixed ones.
  const health = await get(fetchImpl, `${base}/api/health`);
  if (!health) add('health', false, 'no answer inside 10 s');
  else {
    type HealthJson = { status?: string; checks?: Record<string, { ok: boolean; detail: string }> };
    const body: HealthJson | null = await health.json().then((j) => j as HealthJson).catch(() => null);
    const status = body?.status;
    const failing = Object.entries(body?.checks ?? {}).filter(([, c]) => !c.ok).map(([k, c]) => `${k}: ${c.detail}`);
    if (health.status === 200 && (status === 'ok' || status === 'degraded')) add('health', true, status === 'ok' ? 'ok' : `degraded (${failing.join('; ')})`);
    else add('health', false, `HTTP ${health.status}, status "${status ?? 'unreadable'}"${failing.length ? ` (${failing.join('; ')})` : ''}`);
    add('health is not cached', health.headers.get('cache-control')?.includes('no-store') ?? false, health.headers.get('cache-control') ?? 'no Cache-Control');
  }

  // 2. The sign-in page renders and carries every security header, plus the nonce policy.
  const login = await get(fetchImpl, `${base}/login`);
  if (!login) add('login page', false, 'no answer');
  else {
    const html = await login.text();
    add('login page', login.status === 200 && /<main\b/.test(html), `HTTP ${login.status}${/<main\b/.test(html) ? ', has a main landmark' : ', no main landmark'}`);
    for (const h of SECURITY_HEADERS as { key: string; value: string }[]) {
      if (h.key.toLowerCase() === 'content-security-policy') continue; // checked below: the static floor plus the gate's nonce policy arrive as one joined header
      const got = login.headers.get(h.key);
      add(`header ${h.key}`, got === h.value, got === h.value ? 'present' : got ? 'present with a different value' : 'absent');
    }
    const csp = login.headers.get('content-security-policy') ?? '';
    const missing = (CSP_BASE_DIRECTIVES as string[]).filter((d) => !csp.includes(d));
    const nonced = /script-src [^;]*'nonce-[A-Za-z0-9+/=]{16,}'/.test(csp) && /'strict-dynamic'/.test(csp) && !/unsafe-eval/.test(csp);
    add('header Content-Security-Policy', missing.length === 0 && nonced, missing.length ? `missing ${missing.join(', ')}` : nonced ? 'base directives and a per-request script nonce, no unsafe-eval' : csp ? 'no strict per-request script policy' : 'absent');
  }

  // 3. Deny by default: a page redirects to sign-in, an API answers 401 with the internal envelope, an unknown API path is 401 not 404.
  const dash = await get(fetchImpl, `${base}/dashboard`);
  add('unauthenticated page redirects to sign-in', !!dash && dash.status >= 300 && dash.status < 400 && /\/login\?next=/.test(dash.headers.get('location') ?? ''), dash ? `HTTP ${dash.status} → ${dash.headers.get('location') ?? '(no location)'}` : 'no answer');
  const agents = await get(fetchImpl, `${base}/api/agents`);
  add('unauthenticated API answers 401', !!agents && agents.status === 401 && (await agents.json().catch(() => ({})) as { error?: unknown }).error === 'Authentication required.', agents ? `HTTP ${agents.status}` : 'no answer');
  const unknownApi = await get(fetchImpl, `${base}/api/definitely-not-a-route`);
  add('unknown API path is refused, not found', !!unknownApi && unknownApi.status === 401, unknownApi ? `HTTP ${unknownApi.status}` : 'no answer');

  // 4. The public API's own envelope.
  const v1 = await get(fetchImpl, `${base}/api/v1/recommendations`);
  const v1Body = v1 ? ((await v1.json().catch(() => null)) as { error?: { type?: string; code?: string } } | null) : null;
  add('v1 API answers 401 with its envelope', !!v1 && v1.status === 401 && typeof v1Body?.error?.type === 'string' && typeof v1Body?.error?.code === 'string', v1 ? `HTTP ${v1.status}${v1Body?.error?.code ? `, code ${v1Body.error.code}` : ''}` : 'no answer');

  // 5. CSRF: a cookie-bearing cross-site write is refused before anything reads it.
  const csrf = await get(fetchImpl, `${base}/api/auth/logout`, { method: 'POST', headers: { cookie: 'jobpilot_session=smoke', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } });
  add('cross-site write refused', !!csrf && csrf.status === 403, csrf ? `HTTP ${csrf.status}` : 'no answer');

  // 6. The CMS is up: its page, or a redirect to its own sign-in - never a 404 (review L7: a build with the CMS unmounted must fail here).
  const admin = await get(fetchImpl, `${base}/admin`);
  const adminUp = !!admin && (admin.status === 200 || (admin.status >= 300 && admin.status < 400 && /\/admin/.test(admin.headers.get('location') ?? '')));
  add('CMS admin reachable', adminUp, admin ? `HTTP ${admin.status}${admin.headers.get('location') ? ` → ${admin.headers.get('location')}` : ''}` : 'no answer');

  // 7. An unknown page is gated like every other non-public path (a
  //    redirect to sign-in - deny by default runs before routing), never a
  //    500 or a stack trace. The built app answered 307 here on the first
  //    live run, which is right; the first draft of this check expected 404.
  const missing = await get(fetchImpl, `${base}/definitely-not-a-page-${Date.now()}`);
  const missingText = missing ? await missing.text() : '';
  const gated = !!missing && ((missing.status >= 300 && missing.status < 400 && /\/login\?next=/.test(missing.headers.get('location') ?? '')) || missing.status === 404);
  add('unknown page is gated or 404, never an error', gated && !/at .+\.(ts|js):\d+/.test(missingText), missing ? `HTTP ${missing.status}${missing.headers.get('location') ? ` → ${missing.headers.get('location')}` : ''}` : 'no answer');

  return checks;
}
