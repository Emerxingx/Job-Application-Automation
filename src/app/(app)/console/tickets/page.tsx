import { AlertTriangle, Inbox, TimerReset, UserX } from 'lucide-react';
import { db } from '@/lib/db';
import {
  isTicketCategory,
  isTicketPriority,
  isTicketStatus,
  listTickets,
} from '@/lib/crm/tickets';
import { PageHeader } from '@/components/ui';
import { consoleGate } from '../guard';
import { AccessDenied, Kpi, count, dayTime, since } from '../ui';
import { TicketQueue, type TicketRowView } from './ticket-queue';

export const metadata = { title: 'Support' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

/** Statuses that mean somebody still owes the customer something. */
const WORKING = ['open', 'pending', 'on_hold'];

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function one(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

export default async function ConsoleTicketsPage({ searchParams }: { searchParams: SearchParams }) {
  const gate = await consoleGate('support');
  if (!gate.ok) return <AccessDenied />;

  const params = await searchParams;
  const q = one(params.q).trim();
  const statusParam = one(params.status);
  const priorityParam = one(params.priority);
  const categoryParam = one(params.category);
  const assignee = one(params.assignee);
  const breached = one(params.breached);
  const userId = one(params.userId);
  const pageParam = Number.parseInt(one(params.page), 10);
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;

  const status = isTicketStatus(statusParam) ? statusParam : undefined;
  const now = new Date();

  const [result, openCount, unassignedCount, breachedCount, urgentCount, assigneeIds] =
    await Promise.all([
      listTickets(
        {
          status,
          // With no explicit status the queue shows work in progress, not every
          // ticket ever filed — a support queue that opens on 4,000 closed
          // tickets is a queue nobody uses.
          openOnly: !status,
          priority: isTicketPriority(priorityParam) ? priorityParam : undefined,
          category: isTicketCategory(categoryParam) ? categoryParam : undefined,
          assigneeStaffId: assignee && assignee !== 'none' ? assignee : undefined,
          unassigned: assignee === 'none' ? true : undefined,
          userId: userId || undefined,
          breachedSla: breached === '' ? undefined : breached === '1',
          search: q || undefined,
          page,
          pageSize: PAGE_SIZE,
        },
        now,
      ),
      db.supportTicket.count({ where: { status: { in: WORKING } } }),
      db.supportTicket.count({ where: { status: { in: WORKING }, assigneeStaffId: null } }),
      db.supportTicket.count({ where: { status: { in: WORKING }, breachedSla: true } }),
      db.supportTicket.count({ where: { status: { in: WORKING }, priority: 'urgent' } }),
      // Who currently holds work, for the assignee filter. Distinct assignees
      // across the working queue rather than every staff account ever.
      db.supportTicket.findMany({
        where: { status: { in: WORKING }, assigneeStaffId: { not: null } },
        select: { assigneeStaffId: true },
        distinct: ['assigneeStaffId'],
        take: 50,
      }),
    ]);

  const staffIds = assigneeIds
    .map((row) => row.assigneeStaffId)
    .filter((id): id is string => Boolean(id));
  const staffRows = staffIds.length
    ? await db.user.findMany({
        where: { id: { in: staffIds } },
        select: { id: true, fullName: true, email: true },
      })
    : [];

  const rows: TicketRowView[] = result.rows.map((ticket) => ({
    id: ticket.id,
    number: ticket.number,
    subject: ticket.subject,
    status: ticket.status,
    priority: ticket.priority,
    category: ticket.category,
    channel: ticket.channel,
    email: ticket.email,
    customerName: ticket.customerName ?? 'Not a registered account',
    userId: ticket.userId,
    assigneeStaffId: ticket.assigneeStaffId,
    assigneeName: ticket.assigneeName,
    tags: ticket.tags,
    breachedSla: ticket.breachedSla,
    slaAtRisk: ticket.slaAtRisk,
    slaLabel: ticket.firstResponseAt
      ? `Replied ${since(ticket.firstResponseAt, now)}`
      : ticket.slaDueAt
        ? `Due ${since(ticket.slaDueAt, now)}`
        : 'No target',
    lastReplyIso: ticket.lastReplyAt.toISOString(),
    lastReplyLabel: since(ticket.lastReplyAt, now),
    openedIso: ticket.createdAt.toISOString(),
    openedLabel: dayTime(ticket.createdAt),
    messageCount: ticket.messageCount,
    firstResponded: ticket.firstResponseAt !== null,
  }));

  return (
    <>
      <PageHeader
        title="Support queue"
        description="Open, pending and on-hold tickets across every customer. Breached tickets sort to the top of the list."
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label="In the queue"
          value={count(openCount)}
          icon={Inbox}
          tone={openCount > 0 ? 'brand' : 'positive'}
          hint="Open, awaiting customer, or on hold."
        />
        <Kpi
          label="Unassigned"
          value={count(unassignedCount)}
          icon={UserX}
          tone={unassignedCount > 0 ? 'caution' : 'positive'}
          href="/console/tickets?assignee=none"
          hint={
            unassignedCount > 0
              ? 'Nobody owns these yet — an unowned ticket is the one that ages.'
              : 'Everything in the queue has an owner.'
          }
        />
        <Kpi
          label="SLA breached"
          value={count(breachedCount)}
          icon={TimerReset}
          tone={breachedCount > 0 ? 'critical' : 'positive'}
          href="/console/tickets?breached=1"
          hint="First response arrived after the target. Recorded once, never recalculated."
        />
        <Kpi
          label="Urgent"
          value={count(urgentCount)}
          icon={AlertTriangle}
          tone={urgentCount > 0 ? 'critical' : 'neutral'}
          href="/console/tickets?priority=urgent"
          hint="Two-hour first-response target."
        />
      </div>

      <TicketQueue
        rows={rows}
        filters={{
          q,
          status: status ?? '',
          priority: isTicketPriority(priorityParam) ? priorityParam : '',
          category: isTicketCategory(categoryParam) ? categoryParam : '',
          assignee,
          breached: breached === '1' || breached === '0' ? breached : '',
        }}
        staffId={gate.staff.id}
        page={result.page}
        pageCount={result.pageCount}
        total={result.total}
        assignees={staffRows.map((person) => ({
          id: person.id,
          name: person.fullName || person.email,
        }))}
      />
    </>
  );
}
