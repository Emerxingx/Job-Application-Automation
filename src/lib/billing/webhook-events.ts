import { db } from '@/lib/db';

/**
 * Inbound webhook event recording — replay AND ordering.
 *
 * Two independent hazards live on this path, and the `WebhookEvent` model was
 * designed for both. Fixing only the first leaves the second, so this module
 * closes both.
 *
 * 1. REPLAY. Gateways retry. Stripe retries a webhook until it gets a 2xx, and
 *    it will happily deliver the same `evt_…` twice after a timeout that our
 *    handler actually processed. Before Stage 01 the Stripe route dispatched on
 *    every delivery, so a replayed `checkout.session.completed` ran
 *    `activatePlan` again. `@@unique([provider, externalEventId])` is the guard:
 *    the insert fails, we recognise it, and the caller skips.
 *
 * 2. ORDERING. No gateway guarantees order. A `subscription.updated(active)`
 *    delayed in the network can arrive AFTER `subscription.deleted`, which would
 *    resurrect a cancelled subscription — the customer keeps access they
 *    cancelled and stopped paying for. Receipt time cannot detect this; the
 *    gateway's own `occurredAt` can. Before applying a state transition we
 *    compare against the newest already-processed event for the same subject and
 *    discard the older one.
 *
 * The event is recorded only AFTER signature verification, so `payload` never
 * holds unverified attacker-supplied data.
 */

/**
 * Gateway vocabularies normalised to one set, so handlers are written once and
 * never learn a specific gateway's strings. An unrecognised type is recorded as
 * `unknown` and acknowledged — never 500'd, which would make the gateway retry
 * something we will never understand.
 */
export type NormalizedEventType =
  | 'checkout.completed'
  | 'subscription.updated'
  | 'subscription.canceled'
  | 'invoice.paid'
  | 'invoice.payment_failed'
  | 'payment.succeeded'
  | 'payment.failed'
  | 'refund.succeeded'
  | 'dispute.opened'
  | 'unknown';

/** A subject whose state transitions must be ordered (see hazard 2). */
export type SubjectType = 'subscription' | 'invoice' | 'payment';

export interface IncomingWebhookEvent {
  provider: string;
  /** The gateway's own event id — the idempotency key. */
  externalEventId: string;
  type: NormalizedEventType;
  /** The gateway's own type string, kept for triage of `unknown`. */
  rawType: string;
  subjectType?: SubjectType;
  subjectId?: string;
  amountCents?: number;
  currency?: string;
  /** The raw verified body. */
  payload: string;
  livemode: boolean;
  /** The GATEWAY's timestamp, never receipt time. Ordering depends on it. */
  occurredAt: Date;
}

export type RecordOutcome =
  /** First time seen and in order — the caller should dispatch it. */
  | { action: 'process'; eventId: string }
  /** Already recorded. The caller must NOT dispatch. */
  | { action: 'duplicate'; eventId: string; existingStatus: string }
  /**
   * Recorded, but a newer event for the same subject was already processed.
   * Stored for audit and marked `ignored`; the caller must NOT dispatch.
   */
  | { action: 'stale'; eventId: string; newerOccurredAt: Date };

export interface WebhookEventStore {
  /** Insert, or return null when `(provider, externalEventId)` already exists. */
  insert(input: IncomingWebhookEvent): Promise<{ id: string } | null>;
  findExisting(provider: string, externalEventId: string): Promise<{ id: string; status: string } | null>;
  /** Newest already-processed event for a subject, excluding `exceptEventId`. */
  findNewestProcessedForSubject(
    subjectType: string,
    subjectId: string,
    exceptEventId: string,
  ): Promise<{ occurredAt: Date } | null>;
  setStatus(eventId: string, status: string, error?: string): Promise<void>;
}

export function prismaWebhookEventStore(): WebhookEventStore {
  return {
    async insert(input) {
      try {
        const row = await db.webhookEvent.create({
          data: {
            provider: input.provider,
            externalEventId: input.externalEventId,
            type: input.type,
            rawType: input.rawType,
            subjectType: input.subjectType ?? null,
            subjectId: input.subjectId ?? null,
            amountCents: input.amountCents ?? null,
            currency: input.currency ?? null,
            payload: input.payload,
            livemode: input.livemode,
            occurredAt: input.occurredAt,
          },
          select: { id: true },
        });
        return row;
      } catch (error) {
        // P2002 is Prisma's unique-constraint violation. That is the REPLAY
        // path and is entirely expected — the database, not a prior read, is
        // what makes this race-free. A check-then-insert would let two
        // concurrent deliveries of the same event both pass the check.
        if (isUniqueViolation(error)) return null;
        throw error;
      }
    },
    async findExisting(provider, externalEventId) {
      return db.webhookEvent.findUnique({
        where: { provider_externalEventId: { provider, externalEventId } },
        select: { id: true, status: true },
      });
    },
    async findNewestProcessedForSubject(subjectType, subjectId, exceptEventId) {
      return db.webhookEvent.findFirst({
        where: { subjectType, subjectId, status: 'processed', id: { not: exceptEventId } },
        orderBy: { occurredAt: 'desc' },
        select: { occurredAt: true },
      });
    },
    async setStatus(eventId, status, error) {
      await db.webhookEvent.update({
        where: { id: eventId },
        data: {
          status,
          lastError: error ?? null,
          processedAt: status === 'processed' ? new Date() : null,
          attempts: { increment: 1 },
        },
      });
    },
  };
}

/** Whether an error is a unique-constraint violation. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/**
 * Record an inbound event and decide whether the caller may dispatch it.
 *
 * Only `action: 'process'` means dispatch. Both other outcomes are normal
 * operation, not errors, and the route should answer 2xx for all three — a
 * non-2xx makes the gateway retry an event we have deliberately declined.
 */
export async function recordWebhookEvent(
  input: IncomingWebhookEvent,
  store: WebhookEventStore = prismaWebhookEventStore(),
): Promise<RecordOutcome> {
  const inserted = await store.insert(input);

  if (!inserted) {
    const existing = await store.findExisting(input.provider, input.externalEventId);
    // The row must exist — the insert failed on its unique key. If it somehow
    // does not, treat it as a duplicate anyway: declining to act twice is the
    // safe failure direction for a billing state change.
    return {
      action: 'duplicate',
      eventId: existing?.id ?? '',
      existingStatus: existing?.status ?? 'unknown',
    };
  }

  // Ordering guard applies only where the event carries a subject whose state
  // transitions can conflict.
  if (input.subjectType && input.subjectId) {
    const newer = await store.findNewestProcessedForSubject(
      input.subjectType,
      input.subjectId,
      inserted.id,
    );
    if (newer && newer.occurredAt > input.occurredAt) {
      await store.setStatus(inserted.id, 'ignored');
      return { action: 'stale', eventId: inserted.id, newerOccurredAt: newer.occurredAt };
    }
  }

  return { action: 'process', eventId: inserted.id };
}

export async function markWebhookProcessed(
  eventId: string,
  store: WebhookEventStore = prismaWebhookEventStore(),
): Promise<void> {
  await store.setStatus(eventId, 'processed');
}

export async function markWebhookFailed(
  eventId: string,
  error: string,
  store: WebhookEventStore = prismaWebhookEventStore(),
): Promise<void> {
  await store.setStatus(eventId, 'failed', error);
}

export async function markWebhookIgnored(
  eventId: string,
  store: WebhookEventStore = prismaWebhookEventStore(),
): Promise<void> {
  await store.setStatus(eventId, 'ignored');
}

/** Map Stripe's event vocabulary onto the normalized set. */
export function normalizeStripeEventType(rawType: string): NormalizedEventType {
  switch (rawType) {
    case 'checkout.session.completed':
      return 'checkout.completed';
    case 'customer.subscription.updated':
      return 'subscription.updated';
    case 'customer.subscription.deleted':
      return 'subscription.canceled';
    case 'invoice.paid':
    case 'invoice.payment_succeeded':
      return 'invoice.paid';
    case 'invoice.payment_failed':
      return 'invoice.payment_failed';
    case 'charge.succeeded':
    case 'payment_intent.succeeded':
      return 'payment.succeeded';
    case 'charge.failed':
    case 'payment_intent.payment_failed':
      return 'payment.failed';
    case 'charge.refunded':
      return 'refund.succeeded';
    case 'charge.dispute.created':
      return 'dispute.opened';
    default:
      return 'unknown';
  }
}
