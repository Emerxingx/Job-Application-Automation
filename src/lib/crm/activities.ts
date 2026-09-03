/**
 * The customer timeline, staff notes and staff tasks.
 *
 * The timeline merges four sources that are deliberately separate tables:
 *
 *   crm      CrmActivity   — outbound contact, calls, meetings, lifecycle
 *                            changes. Staff-only; the customer must never see
 *                            these, which is why they do not live in
 *                            ActivityEvent.
 *   product  ActivityEvent — the customer's own feed (scan, apply, tailor,
 *                            prep, billing, agent). What they did, in their
 *                            words.
 *   support  SupportTicket/SupportMessage — the conversation.
 *   billing  Invoice / failed Payment — the money milestones support gets
 *                            asked about most.
 *
 * Every entry carries an ACTOR and a VISIBILITY. Attribution is not decoration:
 * "note added" with no name is useless in a handover, and an internal note
 * rendered without its `internal` marker is how staff comments end up quoted
 * back to a customer.
 *
 * Merging happens in the read layer, in memory, over a bounded window per
 * source. A union view would freeze the shape of four tables that change
 * independently, so the merge stays in code.
 */

import { db } from '../db';
import { parseJson } from '../types';
import { ensureCustomer } from './customers';
import type { StaffContext } from './auth';

export type TimelineSource = 'crm' | 'product' | 'support' | 'billing';

export const TIMELINE_SOURCES: readonly TimelineSource[] = ['crm', 'product', 'support', 'billing'];

export function isTimelineSource(value: string): value is TimelineSource {
  return (TIMELINE_SOURCES as readonly string[]).includes(value);
}

export interface TimelineActor {
  type: 'staff' | 'customer' | 'system';
  id: string | null;
  name: string;
  email: string | null;
}

export interface TimelineEntry {
  /** Namespaced so ids from four tables cannot collide in a React key. */
  id: string;
  source: TimelineSource;
  /** Source-specific kind: note | call | apply | invoice.paid | … */
  type: string;
  title: string;
  body: string;
  actor: TimelineActor;
  /**
   * `internal` entries are staff-only. Anything rendered to, or quoted at, a
   * customer must filter on this.
   */
  visibility: 'internal' | 'customer';
  occurredAt: Date;
  /** Deep link into the console, where the source row has a page. */
  href: string | null;
  meta: Record<string, unknown>;
}

const SYSTEM_ACTOR: TimelineActor = { type: 'system', id: null, name: 'JobPilot', email: null };

const DEFAULT_PER_SOURCE = 50;

/** Resolve staff ids to display names in one query. */
async function resolveStaff(ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map<string, { name: string; email: string }>();
  const rows = await db.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, fullName: true, email: true },
  });
  return new Map(rows.map((r) => [r.id, { name: r.fullName || r.email, email: r.email }]));
}

export interface TimelineOptions {
  /** Restrict to a subset of sources. Defaults to all four. */
  sources?: TimelineSource[];
  /** Rows pulled from each source before merging. */
  perSource?: number;
  /** Entries returned after merging. */
  limit?: number;
}

/**
 * The merged, newest-first timeline for one customer.
 *
 * `userId` is the console's customer key; the CrmActivity rows hang off the
 * Customer shell, which may not exist yet for a brand-new signup — in that
 * case the CRM strand is simply empty rather than an error.
 */
export async function getCustomerTimeline(
  userId: string,
  options: TimelineOptions = {},
): Promise<TimelineEntry[]> {
  const sources = options.sources?.length ? options.sources : [...TIMELINE_SOURCES];
  const perSource = Math.max(1, Math.min(200, options.perSource ?? DEFAULT_PER_SOURCE));
  const limit = Math.max(1, Math.min(500, options.limit ?? 100));
  const wants = (source: TimelineSource) => sources.includes(source);

  const customer = await db.customer.findUnique({ where: { userId }, select: { id: true } });
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { fullName: true, email: true },
  });
  if (!user) return [];

  const customerActor: TimelineActor = {
    type: 'customer',
    id: userId,
    name: user.fullName || user.email,
    email: user.email,
  };

  const [crmRows, productRows, ticketRows, messageRows, invoiceRows, paymentRows] =
    await Promise.all([
      wants('crm') && customer
        ? db.crmActivity.findMany({
            where: { customerId: customer.id },
            orderBy: { occurredAt: 'desc' },
            take: perSource,
          })
        : Promise.resolve([]),
      wants('product')
        ? db.activityEvent.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            take: perSource,
          })
        : Promise.resolve([]),
      wants('support')
        ? db.supportTicket.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            take: perSource,
            select: { id: true, number: true, subject: true, priority: true, createdAt: true },
          })
        : Promise.resolve([]),
      wants('support')
        ? db.supportMessage.findMany({
            where: { ticket: { userId } },
            orderBy: { createdAt: 'desc' },
            take: perSource,
            select: {
              id: true,
              ticketId: true,
              authorType: true,
              authorStaffId: true,
              authorName: true,
              body: true,
              internal: true,
              createdAt: true,
              ticket: { select: { number: true, subject: true } },
            },
          })
        : Promise.resolve([]),
      wants('billing')
        ? db.invoice.findMany({
            where: { userId, status: { not: 'draft' } },
            orderBy: { createdAt: 'desc' },
            take: perSource,
            select: {
              id: true,
              number: true,
              status: true,
              currency: true,
              totalCents: true,
              amountDueCents: true,
              issuedAt: true,
              paidAt: true,
              voidedAt: true,
              createdAt: true,
            },
          })
        : Promise.resolve([]),
      wants('billing')
        ? db.payment.findMany({
            where: { userId, status: 'failed' },
            orderBy: { createdAt: 'desc' },
            take: perSource,
            select: {
              id: true,
              amountCents: true,
              currency: true,
              failureCode: true,
              failureMessage: true,
              failedAt: true,
              createdAt: true,
            },
          })
        : Promise.resolve([]),
    ]);

  const staff = await resolveStaff([
    ...crmRows.map((r) => r.staffId),
    ...messageRows.map((r) => r.authorStaffId),
  ]);

  const staffActor = (id: string | null): TimelineActor => {
    if (!id) return SYSTEM_ACTOR;
    const found = staff.get(id);
    return {
      type: 'staff',
      id,
      name: found?.name ?? 'Former staff',
      email: found?.email ?? null,
    };
  };

  const entries: TimelineEntry[] = [];

  for (const row of crmRows) {
    entries.push({
      id: `crm:${row.id}`,
      source: 'crm',
      type: row.type,
      title: row.subject || row.type,
      body: row.body,
      actor: staffActor(row.staffId),
      // Every CrmActivity is staff-only by construction — that is the reason
      // this table exists apart from ActivityEvent.
      visibility: 'internal',
      occurredAt: row.occurredAt,
      href: row.relatedTicketId ? `/console/tickets/${row.relatedTicketId}` : null,
      meta: {
        direction: row.direction,
        source: row.source,
        ...parseJson<Record<string, unknown>>(row.meta, {}),
      },
    });
  }

  for (const row of productRows) {
    entries.push({
      id: `product:${row.id}`,
      source: 'product',
      type: row.type,
      title: row.message,
      body: '',
      actor: customerActor,
      visibility: 'customer',
      occurredAt: row.createdAt,
      href: null,
      meta: parseJson<Record<string, unknown>>(row.meta, {}),
    });
  }

  for (const row of ticketRows) {
    entries.push({
      id: `ticket:${row.id}`,
      source: 'support',
      type: 'ticket.opened',
      title: `Ticket ${row.number} opened — ${row.subject}`,
      body: '',
      actor: customerActor,
      visibility: 'customer',
      occurredAt: row.createdAt,
      href: `/console/tickets/${row.id}`,
      meta: { priority: row.priority, number: row.number },
    });
  }

  for (const row of messageRows) {
    const actor: TimelineActor =
      row.authorType === 'staff'
        ? staffActor(row.authorStaffId)
        : row.authorType === 'customer'
          ? customerActor
          : SYSTEM_ACTOR;
    entries.push({
      id: `message:${row.id}`,
      source: 'support',
      type: row.internal ? 'ticket.internal_note' : `ticket.${row.authorType}_reply`,
      title: `${row.ticket.number} — ${row.internal ? 'internal note' : 'reply'}`,
      body: row.body,
      actor: row.authorName ? { ...actor, name: actor.name || row.authorName } : actor,
      visibility: row.internal ? 'internal' : 'customer',
      occurredAt: row.createdAt,
      href: `/console/tickets/${row.ticketId}`,
      meta: { ticketNumber: row.ticket.number, subject: row.ticket.subject },
    });
  }

  for (const row of invoiceRows) {
    const label = row.number ?? row.id.slice(0, 8);
    const at = row.paidAt ?? row.voidedAt ?? row.issuedAt ?? row.createdAt;
    entries.push({
      id: `invoice:${row.id}`,
      source: 'billing',
      type: `invoice.${row.status}`,
      title: `Invoice ${label} ${row.status}`,
      body: '',
      actor: SYSTEM_ACTOR,
      visibility: 'customer',
      occurredAt: at,
      href: `/console/customers/${userId}`,
      meta: {
        status: row.status,
        currency: row.currency,
        totalCents: row.totalCents,
        amountDueCents: row.amountDueCents,
      },
    });
  }

  for (const row of paymentRows) {
    entries.push({
      id: `payment:${row.id}`,
      source: 'billing',
      type: 'payment.failed',
      title: `Payment failed${row.failureCode ? ` (${row.failureCode})` : ''}`,
      body: row.failureMessage ?? '',
      actor: SYSTEM_ACTOR,
      visibility: 'customer',
      occurredAt: row.failedAt ?? row.createdAt,
      href: null,
      meta: { amountCents: row.amountCents, currency: row.currency, code: row.failureCode },
    });
  }

  entries.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
  return entries.slice(0, limit);
}

// --- Activity logging -------------------------------------------------------

export const CRM_ACTIVITY_TYPES = [
  'note',
  'email',
  'call',
  'meeting',
  'ticket',
  'billing',
  'system',
  'task',
  'lifecycle',
] as const;
export type CrmActivityType = (typeof CRM_ACTIVITY_TYPES)[number];

export const CRM_DIRECTIONS = ['inbound', 'outbound', 'internal'] as const;
export type CrmDirection = (typeof CRM_DIRECTIONS)[number];

export function isCrmActivityType(value: string): value is CrmActivityType {
  return (CRM_ACTIVITY_TYPES as readonly string[]).includes(value);
}

export function isCrmDirection(value: string): value is CrmDirection {
  return (CRM_DIRECTIONS as readonly string[]).includes(value);
}

export interface LogActivityInput {
  userId: string;
  staff: StaffContext | null;
  type: CrmActivityType;
  direction?: CrmDirection;
  subject?: string;
  body?: string;
  relatedTicketId?: string | null;
  relatedInvoiceId?: string | null;
  meta?: Record<string, unknown>;
  occurredAt?: Date;
}

/**
 * Append one entry to the staff timeline.
 *
 * CrmActivity is append-only — nothing here updates a row. An editable audit
 * trail is not an audit trail, which is exactly why editable notes live in
 * CrmNote instead.
 *
 * Contact in either direction also stamps Customer.lastContactedAt, so
 * "when did anyone last speak to them" is one column rather than a scan.
 */
export async function logActivity(input: LogActivityInput) {
  const customer = await ensureCustomer(input.userId);
  const occurredAt = input.occurredAt ?? new Date();
  const direction = input.direction ?? 'internal';

  const activity = await db.crmActivity.create({
    data: {
      customerId: customer.id,
      staffId: input.staff?.id ?? null,
      type: input.type,
      direction,
      subject: input.subject ?? '',
      body: input.body ?? '',
      source: 'console',
      relatedTicketId: input.relatedTicketId ?? null,
      relatedInvoiceId: input.relatedInvoiceId ?? null,
      meta: JSON.stringify(input.meta ?? {}),
      occurredAt,
    },
  });

  const contactMade =
    direction !== 'internal' && ['email', 'call', 'meeting', 'ticket'].includes(input.type);
  if (contactMade) {
    await db.customer.update({
      where: { id: customer.id },
      data: { lastContactedAt: occurredAt, lastActivityAt: occurredAt },
    });
  }

  return activity;
}

// --- Notes ------------------------------------------------------------------

export interface NoteView {
  id: string;
  staffId: string;
  staffName: string;
  staffEmail: string | null;
  body: string;
  pinned: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Notes for a customer, pinned first then newest first. */
export async function listNotes(userId: string, limit = 50): Promise<NoteView[]> {
  const customer = await db.customer.findUnique({ where: { userId }, select: { id: true } });
  if (!customer) return [];

  const notes = await db.crmNote.findMany({
    where: { customerId: customer.id },
    orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
    take: Math.max(1, Math.min(200, limit)),
  });

  const staff = await resolveStaff(notes.map((n) => n.staffId));
  return notes.map((n) => ({
    id: n.id,
    staffId: n.staffId,
    staffName: staff.get(n.staffId)?.name ?? 'Former staff',
    staffEmail: staff.get(n.staffId)?.email ?? null,
    body: n.body,
    pinned: n.pinned,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
  }));
}

/**
 * Add a staff note.
 *
 * The note itself is mutable (CrmNote), and a matching immutable timeline
 * entry is appended (CrmActivity) so editing a note later cannot rewrite the
 * record that one was written at all.
 */
export async function addNote(
  userId: string,
  staff: StaffContext,
  body: string,
  pinned = false,
): Promise<NoteView> {
  const customer = await ensureCustomer(userId);
  const trimmed = body.trim();

  const note = await db.crmNote.create({
    data: { customerId: customer.id, staffId: staff.id, body: trimmed, pinned },
  });

  await db.crmActivity.create({
    data: {
      customerId: customer.id,
      staffId: staff.id,
      type: 'note',
      direction: 'internal',
      source: 'console',
      subject: 'Note added',
      // First line only: the timeline is a summary, and the note row is the
      // place the full text lives and can be corrected.
      body: trimmed.split('\n')[0]!.slice(0, 280),
      meta: JSON.stringify({ noteId: note.id, pinned }),
    },
  });

  return {
    id: note.id,
    staffId: staff.id,
    staffName: staff.fullName || staff.email,
    staffEmail: staff.email,
    body: note.body,
    pinned: note.pinned,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

/** Pin or unpin a note. Returns null when the note is not on this customer. */
export async function setNotePinned(
  userId: string,
  noteId: string,
  pinned: boolean,
): Promise<NoteView | null> {
  const customer = await db.customer.findUnique({ where: { userId }, select: { id: true } });
  if (!customer) return null;

  const existing = await db.crmNote.findFirst({
    where: { id: noteId, customerId: customer.id },
    select: { id: true },
  });
  if (!existing) return null;

  const note = await db.crmNote.update({ where: { id: noteId }, data: { pinned } });
  const staff = await resolveStaff([note.staffId]);
  return {
    id: note.id,
    staffId: note.staffId,
    staffName: staff.get(note.staffId)?.name ?? 'Former staff',
    staffEmail: staff.get(note.staffId)?.email ?? null,
    body: note.body,
    pinned: note.pinned,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

// --- Tasks ------------------------------------------------------------------

export const TASK_STATUSES = ['open', 'in_progress', 'done', 'canceled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value);
}

export function isTaskPriority(value: string): value is TaskPriority {
  return (TASK_PRIORITIES as readonly string[]).includes(value);
}

export interface TaskView {
  id: string;
  customerId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueAt: Date | null;
  completedAt: Date | null;
  assigneeStaffId: string | null;
  assigneeName: string | null;
  createdByStaffId: string;
  createdByName: string;
  createdAt: Date;
  /** True when the task is still open and its due date has passed. */
  overdue: boolean;
}

function toTaskView(
  task: {
    id: string;
    customerId: string;
    title: string;
    description: string;
    status: string;
    priority: string;
    dueAt: Date | null;
    completedAt: Date | null;
    assigneeStaffId: string | null;
    createdByStaffId: string;
    createdAt: Date;
  },
  staff: Map<string, { name: string; email: string }>,
  now: Date,
): TaskView {
  const status = isTaskStatus(task.status) ? task.status : 'open';
  return {
    id: task.id,
    customerId: task.customerId,
    title: task.title,
    description: task.description,
    status,
    priority: isTaskPriority(task.priority) ? task.priority : 'normal',
    dueAt: task.dueAt,
    completedAt: task.completedAt,
    assigneeStaffId: task.assigneeStaffId,
    assigneeName: task.assigneeStaffId
      ? (staff.get(task.assigneeStaffId)?.name ?? 'Former staff')
      : null,
    createdByStaffId: task.createdByStaffId,
    createdByName: staff.get(task.createdByStaffId)?.name ?? 'Former staff',
    createdAt: task.createdAt,
    overdue:
      (status === 'open' || status === 'in_progress') && task.dueAt !== null && task.dueAt < now,
  };
}

/** Tasks for one customer. Open work first, soonest due first. */
export async function listTasks(
  userId: string,
  options: { includeClosed?: boolean; limit?: number } = {},
  now: Date = new Date(),
): Promise<TaskView[]> {
  const customer = await db.customer.findUnique({ where: { userId }, select: { id: true } });
  if (!customer) return [];

  const tasks = await db.crmTask.findMany({
    where: {
      customerId: customer.id,
      ...(options.includeClosed ? {} : { status: { in: ['open', 'in_progress'] } }),
    },
    orderBy: [{ status: 'asc' }, { dueAt: 'asc' }, { createdAt: 'desc' }],
    take: Math.max(1, Math.min(200, options.limit ?? 50)),
  });

  const staff = await resolveStaff(tasks.flatMap((t) => [t.assigneeStaffId, t.createdByStaffId]));
  return tasks.map((t) => toTaskView(t, staff, now));
}

export interface CreateTaskInput {
  userId: string;
  staff: StaffContext;
  title: string;
  description?: string;
  priority?: TaskPriority;
  dueAt?: Date | null;
  assigneeStaffId?: string | null;
}

/** Create a follow-up. Unassigned tasks default to the staff member creating them. */
export async function createTask(input: CreateTaskInput, now: Date = new Date()): Promise<TaskView> {
  const customer = await ensureCustomer(input.userId);
  const assigneeStaffId = input.assigneeStaffId ?? input.staff.id;

  const task = await db.crmTask.create({
    data: {
      customerId: customer.id,
      createdByStaffId: input.staff.id,
      assigneeStaffId,
      title: input.title.trim(),
      description: input.description?.trim() ?? '',
      priority: input.priority ?? 'normal',
      dueAt: input.dueAt ?? null,
    },
  });

  await db.crmActivity.create({
    data: {
      customerId: customer.id,
      staffId: input.staff.id,
      type: 'task',
      direction: 'internal',
      source: 'console',
      subject: `Task created: ${task.title}`,
      body: task.description,
      meta: JSON.stringify({ taskId: task.id, assigneeStaffId, dueAt: task.dueAt }),
    },
  });

  const staff = await resolveStaff([assigneeStaffId, input.staff.id]);
  return toTaskView(task, staff, now);
}

export interface UpdateTaskInput {
  status?: TaskStatus;
  priority?: TaskPriority;
  title?: string;
  description?: string;
  dueAt?: Date | null;
  assigneeStaffId?: string | null;
}

/**
 * Update a task. Returns null when the id does not exist.
 *
 * completedAt is derived from the status rather than accepted from the caller,
 * so a task cannot be "done" without a completion time or carry a stale one
 * after being reopened.
 */
export async function updateTask(
  taskId: string,
  patch: UpdateTaskInput,
  staff: StaffContext,
  now: Date = new Date(),
): Promise<TaskView | null> {
  const existing = await db.crmTask.findUnique({ where: { id: taskId } });
  if (!existing) return null;

  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    data[key] = value;
  }
  if (patch.status) {
    data.completedAt = patch.status === 'done' ? (existing.completedAt ?? now) : null;
  }

  const task = await db.crmTask.update({ where: { id: taskId }, data });

  if (patch.status && patch.status !== existing.status) {
    await db.crmActivity.create({
      data: {
        customerId: task.customerId,
        staffId: staff.id,
        type: 'task',
        direction: 'internal',
        source: 'console',
        subject: `Task ${patch.status}: ${task.title}`,
        body: '',
        meta: JSON.stringify({ taskId: task.id, from: existing.status, to: patch.status }),
      },
    });
  }

  const staffMap = await resolveStaff([task.assigneeStaffId, task.createdByStaffId]);
  return toTaskView(task, staffMap, now);
}

/** The "my queue" view: every open task assigned to one staff member. */
export async function listStaffQueue(
  staffId: string,
  limit = 50,
  now: Date = new Date(),
): Promise<(TaskView & { customerUserId: string; customerName: string })[]> {
  const tasks = await db.crmTask.findMany({
    where: { assigneeStaffId: staffId, status: { in: ['open', 'in_progress'] } },
    orderBy: [{ dueAt: 'asc' }, { createdAt: 'desc' }],
    take: Math.max(1, Math.min(200, limit)),
    include: {
      customer: { select: { userId: true, user: { select: { fullName: true, email: true } } } },
    },
  });

  const staff = await resolveStaff(tasks.flatMap((t) => [t.assigneeStaffId, t.createdByStaffId]));
  return tasks.map((t) => ({
    ...toTaskView(t, staff, now),
    customerUserId: t.customer.userId,
    customerName: t.customer.user.fullName || t.customer.user.email,
  }));
}
