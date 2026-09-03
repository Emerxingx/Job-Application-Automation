/**
 * Outbound webhooks: telling a customer's system that something happened here.
 *
 * ============================================================================
 * THE SIGNATURE SCHEME — a receiver must be able to implement verification
 * from this comment alone, without reading any other file.
 * ============================================================================
 *
 * Every delivery carries these headers:
 *
 *     JobPilot-Signature:   t=1755172800,v1=6f1c…  (64 lowercase hex chars)
 *     JobPilot-Event:       application.submitted
 *     JobPilot-Delivery:    dlv_ck7x2…             (unique per ATTEMPT)
 *     JobPilot-Event-Id:    evt_ck7x2…             (STABLE across retries)
 *     JobPilot-Attempt:     2
 *     JobPilot-Api-Version: 2026-01-01
 *     Content-Type:         application/json
 *
 * `t` is the signing time as a Unix timestamp in WHOLE SECONDS (not
 * milliseconds). `v1` is:
 *
 *     v1 = HEX( HMAC-SHA256( key   = <your endpoint's signing secret, UTF-8 bytes>,
 *                            msg   = <t> + "." + <raw request body>, UTF-8 bytes ) )
 *
 * The signed message is the decimal timestamp, then a single ASCII full stop
 * (0x2E), then the request body byte-for-byte. No whitespace, no newline, no
 * length prefix. The hex is lowercase.
 *
 * TO VERIFY, IN ORDER:
 *
 *   1. Read the RAW request body as bytes, BEFORE any JSON parsing. Do not
 *      re-serialise a parsed object — key order, unicode escaping and number
 *      formatting all differ between JSON writers and any of those differences
 *      changes the HMAC. In Express use `express.raw({type:'application/json'})`;
 *      in Next.js use `await request.text()`.
 *   2. Split the `JobPilot-Signature` header on "," and each element on the
 *      FIRST "=" into key and value. Ignore elements whose key you do not know
 *      — future schemes will add `v2=…` alongside `v1=`.
 *   3. Reject if `Math.abs(nowSeconds - t) > 300`. This is what stops an
 *      attacker replaying a genuine, correctly-signed delivery captured a week
 *      ago. Five minutes is the tolerance we send within; see
 *      WEBHOOK_TOLERANCE_SECONDS.
 *   4. Recompute the HMAC and compare against EVERY `v1` element present, with
 *      a constant-time comparison (`crypto.timingSafeEqual` in Node,
 *      `hmac.compare_digest` in Python). Accept if any matches. Several `v1`
 *      values appear only while a secret is being rotated; a naive
 *      "first element only" reader breaks silently during rotation.
 *   5. Only then act on the body. Treat delivery as AT-LEAST-ONCE: retries and
 *      network timeouts mean you WILL occasionally see the same
 *      `JobPilot-Event-Id` twice. De-duplicate on it.
 *
 * Reference receiver (Node 18+, no dependencies):
 *
 *     import { createHmac, timingSafeEqual } from 'node:crypto';
 *
 *     function verify(rawBody, header, secret, toleranceSeconds = 300) {
 *       const parts = new Map(
 *         header.split(',').map((p) => {
 *           const i = p.indexOf('=');
 *           return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
 *         }),
 *       );
 *       const t = Number(parts.get('t'));
 *       if (!Number.isFinite(t)) return false;
 *       if (Math.abs(Math.floor(Date.now() / 1000) - t) > toleranceSeconds) return false;
 *
 *       const expected = createHmac('sha256', secret)
 *         .update(`${t}.${rawBody}`, 'utf8')
 *         .digest('hex');
 *
 *       for (const [k, v] of parts) {
 *         if (k !== 'v1' || v.length !== expected.length) continue;
 *         if (timingSafeEqual(Buffer.from(v), Buffer.from(expected))) return true;
 *       }
 *       return false;
 *     }
 *
 * WHY THE TIMESTAMP IS INSIDE THE HMAC. A signature over the body alone is
 * replayable forever: anyone who records one valid delivery can resend it at
 * any time and it stays valid, because nothing in the signed material says
 * when it was made. Binding `t` into the message means a captured delivery
 * expires, and moving `t` outside the signature would let an attacker simply
 * rewrite it. Both halves are load-bearing.
 *
 * WHY NOT TLS/mTLS ALONE. TLS proves you are talking to the URL you dialled.
 * It does not prove to the RECEIVER that the request came from us — anyone can
 * POST JSON to a public endpoint. The HMAC is what makes the receiver's
 * authorisation decision sound.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { db } from '../db';
import { parseJson } from '../types';

// --- Constants --------------------------------------------------------------

export const WEBHOOK_API_VERSION = '2026-01-01';

export const WEBHOOK_SIGNATURE_HEADER = 'JobPilot-Signature';
export const WEBHOOK_EVENT_HEADER = 'JobPilot-Event';
export const WEBHOOK_DELIVERY_HEADER = 'JobPilot-Delivery';
export const WEBHOOK_EVENT_ID_HEADER = 'JobPilot-Event-Id';
export const WEBHOOK_ATTEMPT_HEADER = 'JobPilot-Attempt';
export const WEBHOOK_API_VERSION_HEADER = 'JobPilot-Api-Version';

/** Replay window, in seconds, on both sides of `t`. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/** How long we wait for a receiver before calling the attempt a timeout. */
export const WEBHOOK_TIMEOUT_MS = 10_000;

/** Response bodies are stored truncated — a receiver returning an HTML error
 *  page would otherwise put kilobytes of markup in every delivery row. */
export const WEBHOOK_RESPONSE_LOG_LIMIT = 2_048;

// --- Event types ------------------------------------------------------------

/**
 * The published catalogue. These strings are a public contract: customers
 * store them in their endpoint subscriptions, so renaming one is a breaking
 * change and removing one silently stops deliveries.
 */
export const WEBHOOK_EVENT_TYPES = [
  'application.submitted',
  'application.status_changed',
  'job.matched',
  'invoice.paid',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/**
 * `ping` is deliberately NOT in the catalogue above. It exists only for the
 * "send test event" button, is always delivered to the endpoint it targets
 * regardless of that endpoint's subscription, and must never be produced by
 * `emitEvent`. Keeping it out of the catalogue is what stops it appearing as a
 * subscribable option in the UI.
 */
export const WEBHOOK_PING_EVENT = 'ping';

export function isWebhookEventType(value: unknown): value is WebhookEventType {
  return typeof value === 'string' && (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Human-facing descriptions, for the endpoint editor.
 */
export const WEBHOOK_EVENT_DESCRIPTIONS: Record<WebhookEventType, string> = {
  'application.submitted': 'An application was submitted to an employer.',
  'application.status_changed': 'An application moved to a new status (interviewing, offer, rejected…).',
  'job.matched': 'An agent matched a new job above its score threshold.',
  'invoice.paid': 'An invoice was paid in full.',
};

/**
 * Does an endpoint subscribed to `subscribed` want `type`?
 *
 * Three forms are accepted, and the wildcard forms are why this is not just
 * `Array.includes`:
 *
 *     "*"                  everything, including event types added later
 *     "application.*"      every event in the `application` namespace
 *     "application.submitted"   exactly that event
 *
 * A trailing `.*` matches the namespace and NOT the bare namespace name, so
 * `application.*` never matches a hypothetical event literally called
 * `application`.
 */
export function matchesSubscription(subscribed: readonly string[], type: string): boolean {
  for (const pattern of subscribed) {
    if (pattern === '*') return true;
    if (pattern === type) return true;
    if (pattern.endsWith('.*') && type.startsWith(pattern.slice(0, -1))) return true;
  }
  return false;
}

/** Read the `events` JSON column, keeping only patterns we can evaluate. */
export function parseSubscribedEvents(value: string | null | undefined): string[] {
  const raw = parseJson<unknown[]>(value, []);
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (trimmed === '*' || trimmed.endsWith('.*') || isWebhookEventType(trimmed)) out.add(trimmed);
  }
  return [...out];
}

// --- Signing ----------------------------------------------------------------

/** The exact bytes the HMAC is taken over: `${timestamp}.${body}`. */
export function signaturePayload(timestampSeconds: number, body: string): string {
  return `${timestampSeconds}.${body}`;
}

/** Lowercase hex HMAC-SHA256 of the signed payload. */
export function computeSignature(secret: string, timestampSeconds: number, body: string): string {
  return createHmac('sha256', secret)
    .update(signaturePayload(timestampSeconds, body), 'utf8')
    .digest('hex');
}

/** The full `JobPilot-Signature` header value. */
export function signatureHeader(secret: string, timestampSeconds: number, body: string): string {
  return `t=${timestampSeconds},v1=${computeSignature(secret, timestampSeconds, body)}`;
}

export interface ParsedSignatureHeader {
  timestamp: number | null;
  /** Every `v1=` value present, in the order they appeared. */
  signatures: string[];
}

/**
 * Parse a signature header leniently.
 *
 * Splits each element on the FIRST `=` only, because a base64 scheme added
 * later could contain `=` padding in its value. Unknown keys are ignored
 * rather than rejected — that forward-compatibility is what lets us add `v2`
 * without every existing receiver breaking on the same day.
 */
export function parseSignatureHeader(header: string | null | undefined): ParsedSignatureHeader {
  const result: ParsedSignatureHeader = { timestamp: null, signatures: [] };
  if (!header) return result;

  for (const element of header.split(',')) {
    const index = element.indexOf('=');
    if (index <= 0) continue;
    const key = element.slice(0, index).trim();
    const value = element.slice(index + 1).trim();
    if (key === 't') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) result.timestamp = Math.trunc(parsed);
    } else if (key === 'v1' && value) {
      result.signatures.push(value);
    }
  }
  return result;
}

export type SignatureFailure =
  | 'missing_header'
  | 'missing_timestamp'
  | 'missing_signature'
  | 'timestamp_out_of_tolerance'
  | 'signature_mismatch';

export type SignatureVerification = { ok: true } | { ok: false; reason: SignatureFailure };

/**
 * The receiver-side check, implemented here so our own test suite and the
 * connector framework verify against exactly the code path we document rather
 * than a second, subtly different re-implementation.
 */
export function verifySignatureHeader(
  secret: string,
  body: string,
  header: string | null | undefined,
  options: { now?: Date; toleranceSeconds?: number } = {},
): SignatureVerification {
  if (!header) return { ok: false, reason: 'missing_header' };

  const parsed = parseSignatureHeader(header);
  if (parsed.timestamp === null) return { ok: false, reason: 'missing_timestamp' };
  if (parsed.signatures.length === 0) return { ok: false, reason: 'missing_signature' };

  const tolerance = options.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((options.now?.getTime() ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - parsed.timestamp) > tolerance) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' };
  }

  const expected = computeSignature(secret, parsed.timestamp, body);
  const expectedBuffer = Buffer.from(expected, 'utf8');
  for (const candidate of parsed.signatures) {
    const candidateBuffer = Buffer.from(candidate, 'utf8');
    if (candidateBuffer.length !== expectedBuffer.length) continue;
    if (timingSafeEqual(candidateBuffer, expectedBuffer)) return { ok: true };
  }
  return { ok: false, reason: 'signature_mismatch' };
}

/**
 * A signing secret for a new endpoint.
 *
 * The `whsec_` prefix is not decoration: it is what makes a leaked secret
 * greppable in a customer's logs and recognisable in a screenshot, and it is
 * the convention receivers already know from other webhook providers.
 */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('hex')}`;
}

// --- Retry schedule ---------------------------------------------------------

/**
 * Total attempts per event, first try included. Six attempts over the schedule
 * below spans about five and a half hours, which covers a deploy, a restart and
 * a short outage without keeping a dead endpoint in the queue for days.
 */
export const WEBHOOK_MAX_ATTEMPTS = 6;

/** Delay before attempt 2, in seconds. Each later gap multiplies by the factor. */
export const WEBHOOK_BACKOFF_BASE_SECONDS = 60;
export const WEBHOOK_BACKOFF_FACTOR = 4;
/** Six hours. Without a cap the sixth gap would be 61 hours. */
export const WEBHOOK_BACKOFF_CAP_SECONDS = 21_600;

/**
 * How long to wait after `attempt` failed, before the next attempt.
 *
 * Returns null when `attempt` was the last one — the caller uses that null to
 * decide "exhausted" rather than duplicating the max-attempts comparison, so
 * there is exactly one place that knows when to stop.
 *
 * The schedule, in seconds: 60, 240, 960, 3840, 15360 → then exhausted.
 * Cumulative wait to the sixth and final attempt is 20,460s ≈ 5h41m.
 */
export function backoffSeconds(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`Attempt must be a positive integer, received ${attempt}`);
  }
  if (attempt >= WEBHOOK_MAX_ATTEMPTS) return null;
  const raw = WEBHOOK_BACKOFF_BASE_SECONDS * WEBHOOK_BACKOFF_FACTOR ** (attempt - 1);
  return Math.min(WEBHOOK_BACKOFF_CAP_SECONDS, Math.round(raw));
}

/**
 * `backoffSeconds` spread by ±20%.
 *
 * Without jitter, an outage that fails a thousand deliveries at once retries
 * all thousand at the same instant, and keeps doing so on every gap — we would
 * be hammering a recovering server in perfectly synchronised waves. The
 * randomness is passed in rather than drawn inside so the schedule is testable:
 * `jitterRatio` of exactly 0.5 returns the un-jittered value.
 */
export function jitteredBackoffSeconds(attempt: number, jitterRatio = Math.random()): number | null {
  const base = backoffSeconds(attempt);
  if (base === null) return null;
  const clamped = Math.min(1, Math.max(0, jitterRatio));
  return Math.max(1, Math.round(base * (0.8 + 0.4 * clamped)));
}

/** When attempt `attempt + 1` should run, or null when there is no next attempt. */
export function nextRetryAt(
  attempt: number,
  from: Date = new Date(),
  jitterRatio = Math.random(),
): Date | null {
  const seconds = jitteredBackoffSeconds(attempt, jitterRatio);
  if (seconds === null) return null;
  return new Date(from.getTime() + seconds * 1000);
}

/**
 * Whether an HTTP status is worth trying again.
 *
 * 5xx is the server saying "not me, not now". 429 is the server explicitly
 * asking us to slow down, which is a retry instruction, not a rejection. 408 is
 * a timeout the receiver noticed itself. Everything else in 4xx is the receiver
 * saying the request is wrong — 404 on a deleted endpoint, 401 on a rotated
 * secret — and retrying that for six hours just wastes both sides' capacity
 * without any path to success.
 */
export function shouldRetryStatus(status: number): boolean {
  if (status >= 500) return true;
  return status === 408 || status === 429;
}

/** A 2xx is a success; a receiver that means "accepted" should say so with 2xx. */
export function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

// --- Transport --------------------------------------------------------------

export interface WebhookRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
  timeoutMs: number;
}

export interface WebhookResponse {
  status: number;
  body: string;
}

/**
 * The network. Injected so the delivery engine can be exercised without a
 * server, and so a future deployment could route deliveries through an egress
 * proxy by swapping this alone.
 */
export type WebhookTransport = (request: WebhookRequest) => Promise<WebhookResponse>;

/**
 * The real transport.
 *
 * `redirect: 'error'` is deliberate. Following a redirect would re-POST the
 * signed body to a host the customer never registered, which turns a webhook
 * endpoint into an open relay for signed traffic — and the signature would
 * still be valid at the destination.
 */
export const fetchTransport: WebhookTransport = async (request) => {
  const response = await fetch(request.url, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
    redirect: 'error',
    signal: AbortSignal.timeout(request.timeoutMs),
  });
  const text = await response.text().catch(() => '');
  return { status: response.status, body: text.slice(0, WEBHOOK_RESPONSE_LOG_LIMIT) };
};

/**
 * Reject URLs we must not POST to.
 *
 * A customer-supplied URL is a server-side request forgery vector: `http://
 * 169.254.169.254/` is the cloud metadata service, and `http://localhost:6379/`
 * is very often an unauthenticated Redis. We cannot fully close SSRF without
 * resolving DNS at request time and re-checking the resolved address (a
 * hostname can point at 127.0.0.1, and can change between check and connect),
 * which needs a custom agent this deployment does not have. What this does
 * close is the whole class of accidents and the obvious literal attempts, and
 * it states plainly what it does not cover.
 */
export function validateWebhookUrl(raw: string): { ok: true; url: URL } | { ok: false; message: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, message: 'That is not a valid URL.' };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, message: 'Webhook URLs must be http or https.' };
  }
  if (url.protocol === 'http:' && process.env.NODE_ENV === 'production') {
    return { ok: false, message: 'Webhook URLs must use https. Payloads carry personal data.' };
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const blocked =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '0.0.0.0' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^(fc|fd)[0-9a-f]{2}:/.test(host) ||
    /^fe80:/.test(host);

  // Loopback is genuinely useful when developing against a local receiver, so
  // it is blocked only where a real customer's data would be at stake.
  if (blocked && process.env.NODE_ENV === 'production') {
    return { ok: false, message: 'Webhook URLs must point at a public host.' };
  }

  return { ok: true, url };
}

// --- Delivery ---------------------------------------------------------------

/**
 * The delivery states, and what each one means. `WebhookDelivery` holds ONE
 * ATTEMPT — a retry is a new row, so the log shows every try rather than only
 * the last.
 *
 *   pending    scheduled, not yet attempted. `nextRetryAt` is when it is due
 *              and is ALWAYS set (never null), so the worker's single query
 *              `status='pending' AND nextRetryAt <= now` uses the schema's
 *              @@index([status, nextRetryAt]) with no OR branch.
 *   succeeded  terminal. Receiver answered 2xx.
 *   failed     this attempt failed AND a successor row is already scheduled.
 *              Purely historical; the worker never looks at it again.
 *   exhausted  terminal failure. Either the response was not worth retrying,
 *              or this was attempt WEBHOOK_MAX_ATTEMPTS.
 *   skipped    terminal. The endpoint was paused, disabled or deleted between
 *              scheduling and the attempt, so nothing was sent.
 */
export type DeliveryStatus = 'pending' | 'succeeded' | 'failed' | 'exhausted' | 'skipped';

export interface DeliveryTarget {
  id: string;
  url: string;
  secret: string;
  apiVersion: string;
}

export interface DeliveryPayload {
  /** `OutboundEvent.id` — stable across every retry of this event. */
  eventId: string;
  type: string;
  /** The serialised JSON body, exactly as it will be signed and sent. */
  body: string;
}

export interface AttemptResult {
  status: Exclude<DeliveryStatus, 'pending' | 'skipped'>;
  signature: string;
  responseStatus: number | null;
  responseBody: string;
  errorMessage: string | null;
  durationMs: number;
  /** When the next attempt is due, or null when this was terminal. */
  retryAt: Date | null;
  nextAttempt: number | null;
}

/**
 * Perform exactly one attempt and classify the outcome. Pure of the database —
 * it takes what to send and reports what happened, and the caller writes rows.
 */
export async function attemptDelivery(
  target: DeliveryTarget,
  payload: DeliveryPayload,
  attempt: number,
  options: {
    transport?: WebhookTransport;
    now?: Date;
    deliveryId?: string;
    jitterRatio?: number;
    timeoutMs?: number;
  } = {},
): Promise<AttemptResult> {
  const transport = options.transport ?? fetchTransport;
  const now = options.now ?? new Date();
  const timestampSeconds = Math.floor(now.getTime() / 1000);
  const signature = signatureHeader(target.secret, timestampSeconds, payload.body);
  const startedAt = Date.now();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'JobPilot-Webhooks/1.0',
    [WEBHOOK_SIGNATURE_HEADER]: signature,
    [WEBHOOK_EVENT_HEADER]: payload.type,
    [WEBHOOK_EVENT_ID_HEADER]: payload.eventId,
    [WEBHOOK_ATTEMPT_HEADER]: String(attempt),
    [WEBHOOK_API_VERSION_HEADER]: target.apiVersion || WEBHOOK_API_VERSION,
  };
  if (options.deliveryId) headers[WEBHOOK_DELIVERY_HEADER] = options.deliveryId;

  const scheduleRetry = (): { retryAt: Date | null; nextAttempt: number | null } => {
    const retryAt = nextRetryAt(attempt, now, options.jitterRatio ?? Math.random());
    return retryAt ? { retryAt, nextAttempt: attempt + 1 } : { retryAt: null, nextAttempt: null };
  };

  try {
    const response = await transport({
      url: target.url,
      body: payload.body,
      headers,
      timeoutMs: options.timeoutMs ?? WEBHOOK_TIMEOUT_MS,
    });
    const durationMs = Date.now() - startedAt;
    const responseBody = response.body.slice(0, WEBHOOK_RESPONSE_LOG_LIMIT);

    if (isSuccessStatus(response.status)) {
      return {
        status: 'succeeded',
        signature,
        responseStatus: response.status,
        responseBody,
        errorMessage: null,
        durationMs,
        retryAt: null,
        nextAttempt: null,
      };
    }

    if (!shouldRetryStatus(response.status)) {
      return {
        status: 'exhausted',
        signature,
        responseStatus: response.status,
        responseBody,
        errorMessage: `Endpoint answered ${response.status}, which is not retryable.`,
        durationMs,
        retryAt: null,
        nextAttempt: null,
      };
    }

    const { retryAt, nextAttempt } = scheduleRetry();
    return {
      status: retryAt ? 'failed' : 'exhausted',
      signature,
      responseStatus: response.status,
      responseBody,
      errorMessage: `Endpoint answered ${response.status}.`,
      durationMs,
      retryAt,
      nextAttempt,
    };
  } catch (error) {
    // No status at all: DNS failure, connection refused, TLS error, timeout,
    // or the blocked redirect. All transient-looking, so all retryable.
    const durationMs = Date.now() - startedAt;
    const { retryAt, nextAttempt } = scheduleRetry();
    return {
      status: retryAt ? 'failed' : 'exhausted',
      signature,
      responseStatus: null,
      responseBody: '',
      errorMessage: error instanceof Error ? error.message : 'Delivery failed.',
      durationMs,
      retryAt,
      nextAttempt,
    };
  }
}

// --- Persistence ------------------------------------------------------------

/** Consecutive failures before an endpoint is switched off automatically. */
export const WEBHOOK_DISABLE_AFTER_FAILURES = 10;

export interface EmitEventInput {
  userId: string;
  type: WebhookEventType;
  payload: Record<string, unknown>;
  subjectType?: string;
  subjectId?: string;
}

export interface EmitEventResult {
  eventId: string;
  /** Delivery rows created, one per subscribed active endpoint. */
  scheduled: number;
}

/**
 * Record that something happened and queue it for every endpoint that wants it.
 *
 * Deliberately does NOT touch the network. The callers are request handlers —
 * submitting an application, paying an invoice — and blocking a user's response
 * on a third-party server that may take ten seconds to time out would make our
 * latency a function of our customers' infrastructure. Rows are written; the
 * worker (`runDueDeliveries`) sends them.
 *
 * Never throws. An outbound webhook is a notification about work that already
 * completed and committed; failing the caller's request because we could not
 * queue a notification would be strictly worse than dropping the notification.
 */
export async function emitEvent(input: EmitEventInput): Promise<EmitEventResult | null> {
  try {
    const endpoints = await db.webhookEndpoint.findMany({
      where: { userId: input.userId, status: 'active' },
    });

    // The `events` column is a JSON string and therefore not queryable, so the
    // subscription filter has to happen here in application code. The schema
    // notes this becomes a join table if endpoint counts ever reach thousands.
    const interested = endpoints.filter((endpoint) =>
      matchesSubscription(parseSubscribedEvents(endpoint.events), input.type),
    );

    const event = await db.outboundEvent.create({
      data: {
        userId: input.userId,
        type: input.type,
        payload: JSON.stringify(input.payload),
        subjectType: input.subjectType ?? null,
        subjectId: input.subjectId ?? null,
        apiVersion: WEBHOOK_API_VERSION,
      },
    });

    const now = new Date();
    for (const endpoint of interested) {
      await db.webhookDelivery.create({
        data: {
          endpointId: endpoint.id,
          eventId: event.id,
          attempt: 1,
          status: 'pending',
          scheduledAt: now,
          nextRetryAt: now,
        },
      });
    }

    return { eventId: event.id, scheduled: interested.length };
  } catch (error) {
    console.error('[webhooks] could not queue event:', error);
    return null;
  }
}

/**
 * The body a receiver sees. Kept in one function so every event has the same
 * envelope and adding a field is a single edit.
 */
export function buildEventBody(event: {
  id: string;
  type: string;
  payload: string;
  occurredAt: Date;
  apiVersion: string;
}): string {
  return JSON.stringify({
    id: event.id,
    type: event.type,
    apiVersion: event.apiVersion || WEBHOOK_API_VERSION,
    occurredAt: event.occurredAt.toISOString(),
    data: parseJson<Record<string, unknown>>(event.payload, {}),
  });
}

export interface WorkerReport {
  claimed: number;
  succeeded: number;
  failed: number;
  exhausted: number;
  skipped: number;
}

/**
 * Send everything that is due.
 *
 * Intended to be driven by a cron. It is also exposed to the signed-in owner
 * through POST /api/integrations/webhooks/deliver, which drains only that
 * user's queue — without either of those, rows would sit `pending` forever,
 * and a queue nobody drains is worse than no queue because it looks like it
 * works.
 *
 * NOT SAFE TO RUN CONCURRENTLY WITH ITSELF. There is no claim/lock column on
 * `WebhookDelivery` (the schema has none), so two workers picking up the same
 * `pending` row would both POST it. With ONE instance that cannot happen.
 * Before running two instances, add a `lockedAt`/`lockedBy` pair as
 * `AgentSchedule` already does and claim rows with a conditional update
 * (ADR-0011 makes this the lease-based worker contract).
 */
export async function runDueDeliveries(
  options: {
    limit?: number;
    now?: Date;
    userId?: string;
    transport?: WebhookTransport;
    jitterRatio?: number;
  } = {},
): Promise<WorkerReport> {
  const now = options.now ?? new Date();
  const limit = Math.min(200, Math.max(1, options.limit ?? 50));
  const report: WorkerReport = { claimed: 0, succeeded: 0, failed: 0, exhausted: 0, skipped: 0 };

  const due = await db.webhookDelivery.findMany({
    where: {
      status: 'pending',
      nextRetryAt: { lte: now },
      ...(options.userId ? { endpoint: { userId: options.userId } } : {}),
    },
    orderBy: { nextRetryAt: 'asc' },
    take: limit,
    include: { endpoint: true, event: true },
  });

  report.claimed = due.length;

  for (const delivery of due) {
    if (delivery.endpoint.status !== 'active') {
      await db.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'skipped',
          errorMessage: `Endpoint is ${delivery.endpoint.status}.`,
          deliveredAt: now,
          nextRetryAt: null,
        },
      });
      report.skipped += 1;
      continue;
    }

    const result = await attemptDelivery(
      {
        id: delivery.endpoint.id,
        url: delivery.endpoint.url,
        secret: delivery.endpoint.secret,
        apiVersion: delivery.endpoint.apiVersion,
      },
      {
        eventId: delivery.event.id,
        type: delivery.event.type,
        body: buildEventBody(delivery.event),
      },
      delivery.attempt,
      {
        transport: options.transport,
        now,
        deliveryId: delivery.id,
        jitterRatio: options.jitterRatio,
      },
    );

    await db.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: result.status,
        signature: result.signature,
        responseStatus: result.responseStatus,
        responseBody: result.responseBody,
        errorMessage: result.errorMessage,
        durationMs: result.durationMs,
        deliveredAt: new Date(),
        nextRetryAt: null,
      },
    });

    if (result.status === 'succeeded') {
      report.succeeded += 1;
      await db.webhookEndpoint.update({
        where: { id: delivery.endpoint.id },
        data: { consecutiveFailures: 0, lastSuccessAt: new Date() },
      });
      continue;
    }

    // A successor attempt, when one is warranted, is a NEW row — that is what
    // makes the delivery log show every try instead of only the final state.
    if (result.status === 'failed' && result.retryAt && result.nextAttempt) {
      await db.webhookDelivery.create({
        data: {
          endpointId: delivery.endpoint.id,
          eventId: delivery.event.id,
          attempt: result.nextAttempt,
          status: 'pending',
          scheduledAt: result.retryAt,
          nextRetryAt: result.retryAt,
        },
      });
      report.failed += 1;
    } else {
      report.exhausted += 1;
    }

    await registerEndpointFailure(delivery.endpoint.id);
  }

  return report;
}

/**
 * Count a failure against an endpoint, disabling it once it has clearly stopped
 * existing. An endpoint whose domain expired would otherwise consume six
 * attempts per event forever, and the customer would never find out.
 */
async function registerEndpointFailure(endpointId: string): Promise<void> {
  const updated = await db.webhookEndpoint.update({
    where: { id: endpointId },
    data: { consecutiveFailures: { increment: 1 }, lastFailureAt: new Date() },
  });

  if (updated.consecutiveFailures >= WEBHOOK_DISABLE_AFTER_FAILURES && updated.status === 'active') {
    await db.webhookEndpoint.update({
      where: { id: endpointId },
      data: {
        status: 'disabled',
        disabledAt: new Date(),
        disabledReason: `Automatically disabled after ${updated.consecutiveFailures} consecutive delivery failures.`,
      },
    });
  }
}

// --- Safe projections -------------------------------------------------------

/**
 * An endpoint as its owner may see it. `secret` is absent by construction.
 *
 * The signing secret is shown exactly once, when the endpoint is created or the
 * secret is rotated. A settings page that re-displays it turns every screenshot,
 * screen-share and browser-cache entry into a way to forge deliveries — and the
 * customer has no way to tell that it happened, because a forged delivery with
 * the right secret is indistinguishable from a real one.
 */
export interface SafeWebhookEndpoint {
  id: string;
  url: string;
  description: string;
  events: string[];
  status: string;
  apiVersion: string;
  consecutiveFailures: number;
  disabledAt: Date | null;
  disabledReason: string | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  createdAt: Date;
}

export function toSafeWebhookEndpoint(row: {
  id: string;
  url: string;
  description: string;
  events: string;
  status: string;
  apiVersion: string;
  consecutiveFailures: number;
  disabledAt: Date | null;
  disabledReason: string | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  createdAt: Date;
}): SafeWebhookEndpoint {
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    events: parseSubscribedEvents(row.events),
    status: row.status,
    apiVersion: row.apiVersion,
    consecutiveFailures: row.consecutiveFailures,
    disabledAt: row.disabledAt,
    disabledReason: row.disabledReason,
    lastSuccessAt: row.lastSuccessAt,
    lastFailureAt: row.lastFailureAt,
    createdAt: row.createdAt,
  };
}

/**
 * One attempt, as shown in the delivery log.
 *
 * `signature` IS included, unlike the secret. It is the value we actually sent,
 * it is a one-way function of a body the customer already has, and it is the
 * single most useful thing to compare against when their verification code
 * rejects a delivery and they cannot tell whose fault it is.
 */
export interface SafeWebhookDelivery {
  id: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  attempt: number;
  status: string;
  signature: string;
  responseStatus: number | null;
  responseBody: string;
  errorMessage: string | null;
  durationMs: number;
  scheduledAt: Date;
  deliveredAt: Date | null;
  nextRetryAt: Date | null;
}

export function toSafeWebhookDelivery(row: {
  id: string;
  endpointId: string;
  eventId: string;
  attempt: number;
  status: string;
  signature: string;
  responseStatus: number | null;
  responseBody: string;
  errorMessage: string | null;
  durationMs: number;
  scheduledAt: Date;
  deliveredAt: Date | null;
  nextRetryAt: Date | null;
  event: { type: string };
}): SafeWebhookDelivery {
  return {
    id: row.id,
    endpointId: row.endpointId,
    eventId: row.eventId,
    eventType: row.event.type,
    attempt: row.attempt,
    status: row.status,
    signature: row.signature,
    responseStatus: row.responseStatus,
    responseBody: row.responseBody,
    errorMessage: row.errorMessage,
    durationMs: row.durationMs,
    scheduledAt: row.scheduledAt,
    deliveredAt: row.deliveredAt,
    nextRetryAt: row.nextRetryAt,
  };
}

/**
 * Send a `ping` straight to one endpoint, bypassing the queue and the
 * subscription filter, and report what the receiver said.
 *
 * This is the button that tells a developer whether their signature
 * verification works, so it is synchronous on purpose: an answer that arrives
 * in a background job an hour later is not a test.
 */
export async function sendTestEvent(
  endpoint: { id: string; url: string; secret: string; apiVersion: string },
  options: { transport?: WebhookTransport; now?: Date } = {},
): Promise<AttemptResult & { body: string }> {
  const now = options.now ?? new Date();
  const body = JSON.stringify({
    id: `evt_test_${now.getTime()}`,
    type: WEBHOOK_PING_EVENT,
    apiVersion: endpoint.apiVersion || WEBHOOK_API_VERSION,
    occurredAt: now.toISOString(),
    data: {
      message: 'This is a test delivery from JobPilot. If you can verify its signature, you are set up correctly.',
      endpointId: endpoint.id,
    },
  });

  const result = await attemptDelivery(
    endpoint,
    { eventId: `evt_test_${now.getTime()}`, type: WEBHOOK_PING_EVENT, body },
    // Attempt WEBHOOK_MAX_ATTEMPTS so a failure is terminal: a manual test must
    // never enqueue six hours of background retries the user did not ask for.
    WEBHOOK_MAX_ATTEMPTS,
    { transport: options.transport, now },
  );

  return { ...result, body };
}
