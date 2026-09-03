import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type IncomingWebhookEvent,
  type WebhookEventStore,
  isUniqueViolation,
  normalizeStripeEventType,
  recordWebhookEvent,
} from '../src/lib/billing/webhook-events';

/** In-memory store enforcing the same unique key the database does. */
function fakeStore() {
  const rows: {
    id: string;
    provider: string;
    externalEventId: string;
    subjectType: string | null;
    subjectId: string | null;
    occurredAt: Date;
    status: string;
    lastError?: string;
  }[] = [];
  let seq = 0;

  const store: WebhookEventStore = {
    async insert(input) {
      const clash = rows.find(
        (r) => r.provider === input.provider && r.externalEventId === input.externalEventId,
      );
      // Mirrors Prisma's P2002 rather than returning null directly, so the
      // module's real error-detection path is exercised.
      if (clash) {
        const err = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        try {
          throw err;
        } catch (e) {
          if (isUniqueViolation(e)) return null;
          throw e;
        }
      }
      const row = {
        id: `evt_row_${++seq}`,
        provider: input.provider,
        externalEventId: input.externalEventId,
        subjectType: input.subjectType ?? null,
        subjectId: input.subjectId ?? null,
        occurredAt: input.occurredAt,
        status: 'received',
      };
      rows.push(row);
      return { id: row.id };
    },
    async findExisting(provider, externalEventId) {
      const r = rows.find((x) => x.provider === provider && x.externalEventId === externalEventId);
      return r ? { id: r.id, status: r.status } : null;
    },
    async findNewestProcessedForSubject(subjectType, subjectId, exceptEventId) {
      const matching = rows
        .filter(
          (r) =>
            r.subjectType === subjectType &&
            r.subjectId === subjectId &&
            r.status === 'processed' &&
            r.id !== exceptEventId,
        )
        .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
      return matching[0] ? { occurredAt: matching[0].occurredAt } : null;
    },
    async setStatus(eventId, status, error) {
      const r = rows.find((x) => x.id === eventId);
      if (r) {
        r.status = status;
        r.lastError = error;
      }
    },
  };

  return { store, rows };
}

function event(over: Partial<IncomingWebhookEvent> = {}): IncomingWebhookEvent {
  return {
    provider: 'stripe',
    externalEventId: 'evt_1',
    type: 'checkout.completed',
    rawType: 'checkout.session.completed',
    payload: '{}',
    livemode: false,
    occurredAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

describe('recordWebhookEvent — replay', () => {
  it('processes an event the first time it is seen', async () => {
    const { store } = fakeStore();
    const out = await recordWebhookEvent(event(), store);
    assert.equal(out.action, 'process');
  });

  it('REFUSES a replayed event id — the revenue-critical case', async () => {
    const { store } = fakeStore();
    const first = await recordWebhookEvent(event(), store);
    const second = await recordWebhookEvent(event(), store);

    assert.equal(first.action, 'process');
    assert.equal(second.action, 'duplicate', 'a replayed event must never be dispatched twice');
    if (second.action === 'duplicate') assert.equal(second.existingStatus, 'received');
  });

  it('treats distinct event ids as distinct even with identical bodies', async () => {
    const { store } = fakeStore();
    await recordWebhookEvent(event({ externalEventId: 'evt_1' }), store);
    const other = await recordWebhookEvent(event({ externalEventId: 'evt_2' }), store);
    assert.equal(other.action, 'process');
  });

  it('scopes the idempotency key by provider', async () => {
    const { store } = fakeStore();
    await recordWebhookEvent(event({ provider: 'stripe', externalEventId: 'evt_same' }), store);
    const paypal = await recordWebhookEvent(
      event({ provider: 'paypal', externalEventId: 'evt_same' }),
      store,
    );
    assert.equal(paypal.action, 'process', 'the same id from another gateway is a different event');
  });
});

describe('recordWebhookEvent — ordering', () => {
  const subject = { subjectType: 'subscription' as const, subjectId: 'sub_1' };

  it('DISCARDS a stale event that would resurrect a cancelled subscription', async () => {
    const { store, rows } = fakeStore();

    // The cancellation happened at 12:00 and was processed.
    const cancel = await recordWebhookEvent(
      event({
        ...subject,
        externalEventId: 'evt_cancel',
        type: 'subscription.canceled',
        occurredAt: new Date('2026-01-01T12:00:00Z'),
      }),
      store,
    );
    assert.equal(cancel.action, 'process');
    if (cancel.action === 'process') await store.setStatus(cancel.eventId, 'processed');

    // A delayed "active" from 11:00 arrives afterwards.
    const late = await recordWebhookEvent(
      event({
        ...subject,
        externalEventId: 'evt_active_delayed',
        type: 'subscription.updated',
        occurredAt: new Date('2026-01-01T11:00:00Z'),
      }),
      store,
    );

    assert.equal(late.action, 'stale', 'an older event must not be applied after a newer one');
    const stored = rows.find((r) => r.externalEventId === 'evt_active_delayed');
    assert.equal(stored?.status, 'ignored', 'the stale event is retained for audit, not dropped');
  });

  it('processes an in-order event for the same subject', async () => {
    const { store } = fakeStore();
    const first = await recordWebhookEvent(
      event({ ...subject, externalEventId: 'e1', occurredAt: new Date('2026-01-01T10:00:00Z') }),
      store,
    );
    if (first.action === 'process') await store.setStatus(first.eventId, 'processed');

    const later = await recordWebhookEvent(
      event({ ...subject, externalEventId: 'e2', occurredAt: new Date('2026-01-01T11:00:00Z') }),
      store,
    );
    assert.equal(later.action, 'process');
  });

  it('does not let one subject block another', async () => {
    const { store } = fakeStore();
    const a = await recordWebhookEvent(
      event({
        subjectType: 'subscription',
        subjectId: 'sub_A',
        externalEventId: 'a1',
        occurredAt: new Date('2026-01-01T12:00:00Z'),
      }),
      store,
    );
    if (a.action === 'process') await store.setStatus(a.eventId, 'processed');

    const b = await recordWebhookEvent(
      event({
        subjectType: 'subscription',
        subjectId: 'sub_B',
        externalEventId: 'b1',
        occurredAt: new Date('2026-01-01T11:00:00Z'),
      }),
      store,
    );
    assert.equal(b.action, 'process', 'ordering is per subject, not global');
  });

  it('applies no ordering guard when the event carries no subject', async () => {
    const { store } = fakeStore();
    const first = await recordWebhookEvent(
      event({ externalEventId: 'n1', occurredAt: new Date('2026-01-01T12:00:00Z') }),
      store,
    );
    if (first.action === 'process') await store.setStatus(first.eventId, 'processed');

    const older = await recordWebhookEvent(
      event({ externalEventId: 'n2', occurredAt: new Date('2026-01-01T10:00:00Z') }),
      store,
    );
    assert.equal(older.action, 'process');
  });

  it('ignores an unprocessed newer event when ordering', async () => {
    const { store } = fakeStore();
    // Newer event recorded but NOT processed — it must not gate an older one,
    // or a failed delivery would permanently block the subject.
    await recordWebhookEvent(
      event({ ...subject, externalEventId: 'newer', occurredAt: new Date('2026-01-01T12:00:00Z') }),
      store,
    );
    const older = await recordWebhookEvent(
      event({ ...subject, externalEventId: 'older', occurredAt: new Date('2026-01-01T11:00:00Z') }),
      store,
    );
    assert.equal(older.action, 'process');
  });
});

describe('normalizeStripeEventType', () => {
  it('maps the types the route dispatches on', () => {
    assert.equal(normalizeStripeEventType('checkout.session.completed'), 'checkout.completed');
    assert.equal(normalizeStripeEventType('customer.subscription.updated'), 'subscription.updated');
    assert.equal(normalizeStripeEventType('customer.subscription.deleted'), 'subscription.canceled');
    assert.equal(normalizeStripeEventType('invoice.payment_failed'), 'invoice.payment_failed');
  });

  it('records an unrecognised type as unknown rather than throwing', () => {
    assert.equal(normalizeStripeEventType('some.future.stripe.event'), 'unknown');
  });
});

describe('isUniqueViolation', () => {
  it('recognises P2002 and nothing else', () => {
    assert.equal(isUniqueViolation({ code: 'P2002' }), true);
    assert.equal(isUniqueViolation({ code: 'P2025' }), false);
    assert.equal(isUniqueViolation(new Error('boom')), false);
    assert.equal(isUniqueViolation(null), false);
    assert.equal(isUniqueViolation(undefined), false);
  });
});
