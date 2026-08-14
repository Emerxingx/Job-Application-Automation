/**
 * Support tickets for the staff console.
 *
 * Three things here are worth reading before changing anything.
 *
 * NUMBERING. SupportTicket.number is non-null and unique, and it comes from
 * the same DocumentSequence table invoices use, keyed (scope, series, year).
 * Allocation happens inside the same transaction as the insert, so a rolled
 * back ticket burns no number. The sequence is deliberately scoped "ticket" /
 * series "TKT": it shares the table with invoice numbering but never the row,
 * so the two counters cannot interfere.
 *
 * SLA. slaDueAt is stamped at creation from the priority, and breachedSla is
 * decided once, when the first public reply lands. Recomputing "breached" on
 * every read would let a ticket un-breach itself when someone lowered its
 * priority afterwards, which is exactly the number a support report must not
 * be able to launder.
 *
 * INTERNAL NOTES. Staff notes and customer replies are the same table
 * separated by SupportMessage.internal. Callers that render a thread to
 * anyone outside the console MUST filter on it — see visibleMessages().
 */

import { db } from '../db';
import { parseJson } from '../types';
import { logActivity } from './activities';
import type { StaffContext } from './auth';

export const TICKET_STATUSES = ['open', 'pending', 'on_hold', 'resolved', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_CATEGORIES = [
  'billing',
  'technical',
  'account',
  'refund',
  'applications',
  'agents',
  'scoring',
  'other',
] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export const TICKET_CHANNELS = ['email', 'in_app', 'chat', 'phone'] as const;
export type TicketChannel = (typeof TICKET_CHANNELS)[number];

export function isTicketStatus(v: string): v is TicketStatus {
  return (TICKET_STATUSES as readonly string[]).includes(v);
}
export function isTicketPriority(v: string): v is TicketPriority {
  return (TICKET_PRIORITIES as readonly string[]).includes(v);
}
export function isTicketCategory(v: string): v is TicketCategory {
  return (TICKET_CATEGORIES as readonly string[]).includes(v);
}
export function isTicketChannel(v: string): v is TicketChannel {
  return (TICKET_CHANNELS as readonly string[]).includes(v);
}

/**
 * First-response targets in hours. These are the promise, not a measurement:
 * changing them changes what counts as a breach from that moment on, and
 * tickets already carrying a slaDueAt keep the target they were sold.
 */
export const SLA_HOURS: Record<TicketPriority, number> = {
  urgent: 2,
  high: 4,
  normal: 24,
  low: 72,
};

const HOUR_MS = 3_600_000;

export function slaDueFor(priority: TicketPriority, from: Date): Date {
  return new Date(from.getTime() + SLA_HOURS[priority] * HOUR_MS);
}

// --- Numbering --------------------------------------------------------------

const TICKET_SCOPE = 'ticket';
const TICKET_SERIES = 'TKT';
const TICKET_PREFIX = 'TKT-';
const TICKET_PADDING = 6;

export function formatTicketNumber(year: number, value: number, padding = TICKET_PADDING): string {
  return `${TICKET_PREFIX}${year}-${String(value).padStart(padding, '0')}`;
}

/**
 * Reserve the next ticket number for a year.
 *
 * Must be called with a transaction client so the reservation and the insert
 * commit together. The upsert returns the sequence AFTER incrementing, so the
 * value just allocated is `nextValue - 1` on both paths — creation seeds
 * nextValue at 2 for exactly that reason.
 *
 * SQLite serialises writers, which is what makes this gap-free here. On
 * Postgres this needs SELECT … FOR UPDATE.
 */
export async function allocateTicketNumber(
  tx: Pick<typeof db, 'documentSequence'>,
  year: number,
): Promise<string> {
  const sequence = await tx.documentSequence.upsert({
    where: { scope_series_year: { scope: TICKET_SCOPE, series: TICKET_SERIES, year } },
    create: {
      scope: TICKET_SCOPE,
      series: TICKET_SERIES,
      year,
      prefix: TICKET_PREFIX,
      nextValue: 2,
      padding: TICKET_PADDING,
    },
    update: { nextValue: { increment: 1 } },
    select: { nextValue: true, padding: true },
  });
  return formatTicketNumber(year, sequence.nextValue - 1, sequence.padding);
}

// --- Context snapshot -------------------------------------------------------

export interface TicketContext {
  planCode: string | null;
  planName: string | null;
  subscriptionStatus: string | null;
  applicationsUsed: number;
  applicationsLimit: number;
  failedApplicationIds: string[];
  openInvoices: number;
  capturedAt: string;
}

/**
 * The diagnosis a ticket ships with.
 *
 * Frozen at creation on purpose: "they were on Starter with 0 of 20
 * applications left and three failed submissions" is the state that produced
 * the complaint, and re-reading it live a week later answers a different
 * question.
 */
export async function buildTicketContext(
  userId: string | null,
  now: Date = new Date(),
): Promise<TicketContext> {
  const empty: TicketContext = {
    planCode: null,
    planName: null,
    subscriptionStatus: null,
    applicationsUsed: 0,
    applicationsLimit: 0,
    failedApplicationIds: [],
    openInvoices: 0,
    capturedAt: now.toISOString(),
  };
  if (!userId) return empty;

  const [subscription, failed, openInvoices] = await Promise.all([
    db.subscription.findUnique({ where: { userId }, include: { plan: true } }),
    db.application.findMany({
      where: { userId, status: 'failed' },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true },
    }),
    db.invoice.count({ where: { userId, status: 'open' } }),
  ]);

  return {
    planCode: subscription?.plan.code ?? null,
    planName: subscription?.plan.name ?? null,
    subscriptionStatus: subscription?.status ?? null,
    applicationsUsed: subscription?.applicationsUsed ?? 0,
    applicationsLimit: subscription
      ? subscription.plan.applicationsPerMonth + subscription.bonusApplications
      : 0,
    failedApplicationIds: failed.map((f) => f.id),
    openInvoices,
    capturedAt: now.toISOString(),
  };
}

// --- Listing ----------------------------------------------------------------

export interface TicketListFilters {
  status?: TicketStatus;
  /** Everything not resolved or closed — the default working queue. */
  openOnly?: boolean;
  priority?: TicketPriority;
  category?: TicketCategory;
  assigneeStaffId?: string;
  /** "unassigned" is a real filter, not the absence of one. */
  unassigned?: boolean;
  userId?: string;
  breachedSla?: boolean;
  /** Matches ticket number, subject or email. */
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface TicketListRow {
  id: string;
  number: string;
  subject: string;
  status: string;
  priority: string;
  category: string;
  channel: string;
  email: string;
  userId: string | null;
  customerName: string | null;
  assigneeStaffId: string | null;
  assigneeName: string | null;
  tags: string[];
  breachedSla: boolean;
  slaDueAt: Date | null;
  firstResponseAt: Date | null;
  lastReplyAt: Date;
  createdAt: Date;
  /** True when nobody has replied yet and the SLA clock has run out. */
  slaAtRisk: boolean;
  messageCount: number;
}

export interface TicketListResult {
  rows: TicketListRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

export async function listTickets(
  filters: TicketListFilters = {},
  now: Date = new Date(),
): Promise<TicketListResult> {
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.floor(filters.pageSize ?? DEFAULT_PAGE_SIZE)),
  );

  const and: Record<string, unknown>[] = [];
  if (filters.status) and.push({ status: filters.status });
  else if (filters.openOnly) and.push({ status: { in: ['open', 'pending', 'on_hold'] } });
  if (filters.priority) and.push({ priority: filters.priority });
  if (filters.category) and.push({ category: filters.category });
  if (filters.assigneeStaffId) and.push({ assigneeStaffId: filters.assigneeStaffId });
  if (filters.unassigned) and.push({ assigneeStaffId: null });
  if (filters.userId) and.push({ userId: filters.userId });
  if (filters.breachedSla !== undefined) and.push({ breachedSla: filters.breachedSla });
  if (filters.search?.trim()) {
    const q = filters.search.trim();
    and.push({
      OR: [{ number: { contains: q } }, { subject: { contains: q } }, { email: { contains: q } }],
    });
  }
  const where = and.length ? { AND: and } : {};

  const [total, tickets] = await Promise.all([
    db.supportTicket.count({ where }),
    db.supportTicket.findMany({
      where,
      // Urgent first would need a CASE expression SQLite orderBy cannot express
      // through Prisma; breached-then-oldest is the queue staff actually work.
      orderBy: [{ breachedSla: 'desc' }, { lastReplyAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        user: { select: { fullName: true, email: true } },
        _count: { select: { messages: true } },
      },
    }),
  ]);

  const staffIds = [
    ...new Set(tickets.map((t) => t.assigneeStaffId).filter((id): id is string => Boolean(id))),
  ];
  const staff = staffIds.length
    ? await db.user.findMany({
        where: { id: { in: staffIds } },
        select: { id: true, fullName: true, email: true },
      })
    : [];
  const staffNames = new Map(staff.map((s) => [s.id, s.fullName || s.email]));

  return {
    rows: tickets.map((t) => ({
      id: t.id,
      number: t.number,
      subject: t.subject,
      status: t.status,
      priority: t.priority,
      category: t.category,
      channel: t.channel,
      email: t.email,
      userId: t.userId,
      customerName: t.user ? t.user.fullName || t.user.email : null,
      assigneeStaffId: t.assigneeStaffId,
      assigneeName: t.assigneeStaffId
        ? (staffNames.get(t.assigneeStaffId) ?? 'Former staff')
        : null,
      tags: parseJson<string[]>(t.tags, []),
      breachedSla: t.breachedSla,
      slaDueAt: t.slaDueAt,
      firstResponseAt: t.firstResponseAt,
      lastReplyAt: t.lastReplyAt,
      createdAt: t.createdAt,
      slaAtRisk: !t.firstResponseAt && t.slaDueAt !== null && t.slaDueAt < now,
      messageCount: t._count.messages,
    })),
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

// --- Detail -----------------------------------------------------------------

export interface TicketMessageView {
  id: string;
  authorType: string;
  authorName: string;
  authorStaffId: string | null;
  body: string;
  internal: boolean;
  attachments: { name: string; path: string; bytes: number }[];
  createdAt: Date;
}

/** Drop staff-only notes. Use this for anything a customer can see. */
export function visibleMessages(messages: TicketMessageView[]): TicketMessageView[] {
  return messages.filter((m) => !m.internal);
}

export async function getTicket(ticketId: string) {
  const ticket = await db.supportTicket.findUnique({
    where: { id: ticketId },
    include: {
      user: { select: { id: true, fullName: true, email: true } },
      messages: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!ticket) return null;

  const staffIds = [
    ...new Set(
      [ticket.assigneeStaffId, ...ticket.messages.map((m) => m.authorStaffId)].filter(
        (id): id is string => Boolean(id),
      ),
    ),
  ];
  const staff = staffIds.length
    ? await db.user.findMany({
        where: { id: { in: staffIds } },
        select: { id: true, fullName: true, email: true },
      })
    : [];
  const staffNames = new Map(staff.map((s) => [s.id, s.fullName || s.email]));

  const messages: TicketMessageView[] = ticket.messages.map((m) => ({
    id: m.id,
    authorType: m.authorType,
    authorName:
      m.authorName ||
      (m.authorStaffId ? (staffNames.get(m.authorStaffId) ?? 'Former staff') : 'JobPilot'),
    authorStaffId: m.authorStaffId,
    body: m.body,
    internal: m.internal,
    attachments: parseJson<{ name: string; path: string; bytes: number }[]>(m.attachments, []),
    createdAt: m.createdAt,
  }));

  return {
    id: ticket.id,
    number: ticket.number,
    subject: ticket.subject,
    status: ticket.status,
    priority: ticket.priority,
    category: ticket.category,
    channel: ticket.channel,
    email: ticket.email,
    userId: ticket.userId,
    customer: ticket.user,
    assigneeStaffId: ticket.assigneeStaffId,
    assigneeName: ticket.assigneeStaffId
      ? (staffNames.get(ticket.assigneeStaffId) ?? 'Former staff')
      : null,
    tags: parseJson<string[]>(ticket.tags, []),
    context: parseJson<Partial<TicketContext>>(ticket.contextSnapshot, {}),
    relatedApplicationId: ticket.relatedApplicationId,
    relatedAgentId: ticket.relatedAgentId,
    firstResponseAt: ticket.firstResponseAt,
    slaDueAt: ticket.slaDueAt,
    breachedSla: ticket.breachedSla,
    resolvedAt: ticket.resolvedAt,
    closedAt: ticket.closedAt,
    satisfactionScore: ticket.satisfactionScore,
    lastReplyAt: ticket.lastReplyAt,
    createdAt: ticket.createdAt,
    messages,
  };
}

export type TicketDetail = NonNullable<Awaited<ReturnType<typeof getTicket>>>;

// --- Creation ---------------------------------------------------------------

export interface CreateTicketInput {
  /** Null for someone who is not a registered user — the schema allows it. */
  userId?: string | null;
  email: string;
  subject: string;
  /** The opening message. There is no `body` column: it becomes message #1. */
  body: string;
  priority?: TicketPriority;
  category?: TicketCategory;
  channel?: TicketChannel;
  tags?: string[];
  relatedApplicationId?: string | null;
  relatedAgentId?: string | null;
  /** Set when a staff member raised the ticket on the customer's behalf. */
  staff?: StaffContext | null;
}

export async function createTicket(
  input: CreateTicketInput,
  now: Date = new Date(),
): Promise<TicketDetail> {
  const priority = input.priority ?? 'normal';
  const context = await buildTicketContext(input.userId ?? null, now);

  const ticket = await db.$transaction(async (tx) => {
    const number = await allocateTicketNumber(tx, now.getUTCFullYear());
    return tx.supportTicket.create({
      data: {
        number,
        userId: input.userId ?? null,
        email: input.email.trim().toLowerCase(),
        subject: input.subject.trim(),
        priority,
        category: input.category ?? 'other',
        channel: input.channel ?? 'in_app',
        tags: JSON.stringify(input.tags ?? []),
        relatedApplicationId: input.relatedApplicationId ?? null,
        relatedAgentId: input.relatedAgentId ?? null,
        contextSnapshot: JSON.stringify(context),
        slaDueAt: slaDueFor(priority, now),
        lastReplyAt: now,
        // A ticket a staff member typed up is already assigned to them.
        assigneeStaffId: input.staff?.id ?? null,
        messages: {
          create: {
            // Authored on the customer's behalf but recorded as theirs — the
            // complaint is the customer's, and marking it "staff" would count
            // as a first response against our own SLA.
            authorType: 'customer',
            authorUserId: input.userId ?? null,
            authorName: input.email,
            body: input.body.trim(),
            internal: false,
          },
        },
      },
      select: { id: true },
    });
  });

  if (input.userId) {
    await logActivity({
      userId: input.userId,
      staff: input.staff ?? null,
      type: 'ticket',
      direction: 'inbound',
      subject: `Ticket opened: ${input.subject.trim()}`,
      body: input.body.trim().slice(0, 280),
      relatedTicketId: ticket.id,
      meta: { priority, category: input.category ?? 'other' },
      occurredAt: now,
    });
  }

  const detail = await getTicket(ticket.id);
  if (!detail) throw new Error('Ticket disappeared immediately after creation');
  return detail;
}

// --- Replies ----------------------------------------------------------------

export interface ReplyInput {
  ticketId: string;
  staff: StaffContext;
  body: string;
  /** True writes a staff-only note into the same thread. */
  internal?: boolean;
  /** Move the ticket on in the same action, as a reply usually does. */
  status?: TicketStatus;
}

/**
 * Post a staff reply or an internal note.
 *
 * Only a PUBLIC reply stops the first-response clock — an internal note is
 * staff talking to staff, and counting it would make the SLA report a measure
 * of how fast we type to each other.
 */
export async function replyToTicket(
  input: ReplyInput,
  now: Date = new Date(),
): Promise<TicketDetail | null> {
  const ticket = await db.supportTicket.findUnique({
    where: { id: input.ticketId },
    select: {
      id: true,
      userId: true,
      subject: true,
      status: true,
      firstResponseAt: true,
      slaDueAt: true,
      breachedSla: true,
    },
  });
  if (!ticket) return null;

  const internal = input.internal ?? false;
  const isFirstPublicResponse = !internal && !ticket.firstResponseAt;

  const data: Record<string, unknown> = { lastReplyAt: now };
  if (isFirstPublicResponse) {
    data.firstResponseAt = now;
    // Decided once, here. Never recomputed on read.
    data.breachedSla = ticket.slaDueAt ? now > ticket.slaDueAt : false;
  }
  if (input.status) {
    data.status = input.status;
    if (input.status === 'resolved') data.resolvedAt = now;
    if (input.status === 'closed') data.closedAt = now;
  } else if (!internal && ticket.status === 'open') {
    // A public reply means the ball is now in the customer's court.
    data.status = 'pending';
  }

  await db.$transaction([
    db.supportMessage.create({
      data: {
        ticketId: ticket.id,
        authorType: 'staff',
        authorStaffId: input.staff.id,
        authorName: input.staff.fullName || input.staff.email,
        body: input.body.trim(),
        internal,
      },
    }),
    db.supportTicket.update({ where: { id: ticket.id }, data }),
  ]);

  // Only outbound contact belongs on the CRM contact timeline; an internal
  // note is not contact and must not stamp lastContactedAt.
  if (ticket.userId && !internal) {
    await logActivity({
      userId: ticket.userId,
      staff: input.staff,
      type: 'ticket',
      direction: 'outbound',
      subject: `Replied on ${ticket.subject}`,
      body: input.body.trim().slice(0, 280),
      relatedTicketId: ticket.id,
      occurredAt: now,
    });
  }

  return getTicket(ticket.id);
}

// --- Updates ----------------------------------------------------------------

export interface TicketPatch {
  status?: TicketStatus;
  priority?: TicketPriority;
  category?: TicketCategory;
  assigneeStaffId?: string | null;
  tags?: string[];
  subject?: string;
}

/**
 * Update ticket metadata.
 *
 * Changing priority moves slaDueAt only while the first response is still
 * outstanding: once the clock has stopped, the target it was measured against
 * is history and rewriting it would rewrite the report.
 */
export async function updateTicket(
  ticketId: string,
  patch: TicketPatch,
  staff: StaffContext,
  now: Date = new Date(),
): Promise<TicketDetail | null> {
  const existing = await db.supportTicket.findUnique({ where: { id: ticketId } });
  if (!existing) return null;

  const data: Record<string, unknown> = {};
  const changed: string[] = [];
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};

  const record = (field: string, current: unknown, next: unknown) => {
    if (current === next) return;
    before[field] = current;
    after[field] = next;
    data[field] = next;
    changed.push(field);
  };

  if (patch.status !== undefined) record('status', existing.status, patch.status);
  if (patch.priority !== undefined) record('priority', existing.priority, patch.priority);
  if (patch.category !== undefined) record('category', existing.category, patch.category);
  if (patch.subject !== undefined) record('subject', existing.subject, patch.subject.trim());
  if (patch.assigneeStaffId !== undefined) {
    record('assigneeStaffId', existing.assigneeStaffId, patch.assigneeStaffId);
  }
  if (patch.tags !== undefined) {
    const next = JSON.stringify(patch.tags);
    record('tags', existing.tags, next);
  }

  if (changed.length === 0) return getTicket(ticketId);

  if (patch.status === 'resolved' && !existing.resolvedAt) data.resolvedAt = now;
  if (patch.status === 'closed' && !existing.closedAt) data.closedAt = now;
  if (patch.priority && !existing.firstResponseAt) {
    data.slaDueAt = slaDueFor(patch.priority, existing.createdAt);
  }

  await db.$transaction([
    db.supportTicket.update({ where: { id: ticketId }, data }),
    db.auditLog.create({
      data: {
        actorType: 'staff',
        actorId: staff.id,
        actorEmail: staff.email,
        actorRole: staff.role,
        action: 'ticket.update',
        entityType: 'SupportTicket',
        entityId: ticketId,
        summary: `${staff.email} updated ${changed.join(', ')} on ${existing.number}`,
        before: JSON.stringify(before),
        after: JSON.stringify(after),
        changedFields: JSON.stringify(changed),
      },
    }),
  ]);

  return getTicket(ticketId);
}
