'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Clock,
  LifeBuoy,
  Loader2,
  Lock,
  Send,
  User,
} from 'lucide-react';
import { DataTable, type Column } from '@/components/data-table';
import { Drawer } from '@/components/drawer';
import { FilterBar, SearchInput, SelectFilter, useDebouncedValue } from '@/components/filters';
import { cn } from '@/components/ui';
import { Field, FieldGrid, Pill, type Tone } from '../ui';

/**
 * The ticket vocabularies, mirrored from lib/crm/tickets.ts.
 *
 * They are not imported because that module pulls in the Prisma client, which
 * must never reach the browser bundle. lib/crm/tickets.ts remains the
 * authority: the server validates every value with `isTicketStatus`,
 * `isTicketPriority` and `isTicketCategory` before it becomes a query, and the
 * PATCH route rejects anything outside its own enum. A value that drifted out
 * of this list would be refused with a 422, not acted on.
 */
const TICKET_STATUSES = ['open', 'pending', 'on_hold', 'resolved', 'closed'] as const;
const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
const TICKET_CATEGORIES = [
  'billing',
  'technical',
  'account',
  'refund',
  'applications',
  'agents',
  'scoring',
  'other',
] as const;

export interface TicketRowView {
  id: string;
  number: string;
  subject: string;
  status: string;
  priority: string;
  category: string;
  channel: string;
  email: string;
  customerName: string;
  userId: string | null;
  assigneeStaffId: string | null;
  assigneeName: string | null;
  tags: string[];
  breachedSla: boolean;
  slaAtRisk: boolean;
  slaLabel: string;
  lastReplyIso: string;
  lastReplyLabel: string;
  openedIso: string;
  openedLabel: string;
  messageCount: number;
  firstResponded: boolean;
}

export interface TicketFilterState {
  q: string;
  status: string;
  priority: string;
  category: string;
  assignee: string;
  breached: string;
}

const PRIORITY_TONE: Record<string, Tone> = {
  urgent: 'critical',
  high: 'caution',
  normal: 'neutral',
  low: 'neutral',
};

const STATUS_TONE: Record<string, Tone> = {
  open: 'brand',
  pending: 'caution',
  on_hold: 'neutral',
  resolved: 'positive',
  closed: 'neutral',
};

const STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  pending: 'Awaiting customer',
  on_hold: 'On hold',
  resolved: 'Resolved',
  closed: 'Closed',
};

/**
 * Sort rank for the priority column, urgent first.
 *
 * Sorting the raw string alphabetises it — "high, low, normal, urgent" — which
 * is the kind of small wrongness that quietly makes a queue useless. Ascending
 * (the first click) puts the most urgent work at the top, which is the order
 * somebody clicking that header is asking for.
 */
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

const label = (value: string) => value.replace(/_/g, ' ');

interface ThreadMessage {
  id: string;
  authorType: string;
  authorName: string;
  body: string;
  internal: boolean;
  createdAt: string;
}

interface ThreadTicket {
  id: string;
  number: string;
  subject: string;
  status: string;
  priority: string;
  category: string;
  channel: string;
  email: string;
  userId: string | null;
  assigneeStaffId: string | null;
  assigneeName: string | null;
  breachedSla: boolean;
  messages: ThreadMessage[];
  context: Record<string, unknown>;
}

export interface TicketQueueProps {
  rows: TicketRowView[];
  filters: TicketFilterState;
  staffId: string;
  page: number;
  pageCount: number;
  total: number;
  /** Distinct assignees currently holding tickets, for the assignee filter. */
  assignees: { id: string; name: string }[];
}

export function TicketQueue({
  rows,
  filters,
  staffId,
  page,
  pageCount,
  total,
  assignees,
}: TicketQueueProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [openId, setOpenId] = useState<string | null>(null);

  const apply = useCallback(
    (next: Record<string, string | null>) => {
      const search = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(next)) {
        if (value === null || value === '') search.delete(key);
        else search.set(key, value);
      }
      if (!('page' in next)) search.delete('page');
      const query = search.toString();
      startTransition(() => router.push(query ? `${pathname}?${query}` : pathname));
    },
    [params, pathname, router],
  );

  const urlQuery = filters.q;
  const [query, setQuery] = useState(urlQuery);
  const debounced = useDebouncedValue(query, 350);

  useEffect(() => {
    if (debounced === urlQuery) return;
    apply({ q: debounced || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const dirty = Boolean(
    filters.q ||
      filters.status ||
      filters.priority ||
      filters.category ||
      filters.assignee ||
      filters.breached,
  );

  const selected = rows.find((row) => row.id === openId) ?? null;

  const columns: Column<TicketRowView>[] = [
    {
      key: 'number',
      header: 'Ticket',
      sortable: true,
      width: '22rem',
      searchText: (row) => `${row.number} ${row.subject} ${row.email}`,
      render: (row) => (
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate">
            <span className="font-mono text-xs text-faint">{row.number}</span>
            <span className="truncate font-semibold text-ink">{row.subject}</span>
          </p>
          <p className="truncate text-xs text-muted">
            {row.customerName} · {row.email}
          </p>
        </div>
      ),
    },
    {
      key: 'priority',
      header: 'Priority',
      sortable: true,
      sortValue: (row) => PRIORITY_RANK[row.priority] ?? 9,
      render: (row) => <Pill tone={PRIORITY_TONE[row.priority] ?? 'neutral'}>{row.priority}</Pill>,
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (row) => (
        <Pill tone={STATUS_TONE[row.status] ?? 'neutral'}>
          {STATUS_LABEL[row.status] ?? row.status}
        </Pill>
      ),
    },
    {
      key: 'slaLabel',
      header: 'First response',
      sortable: true,
      sortValue: (row) => (row.breachedSla ? 0 : row.slaAtRisk ? 1 : 2),
      render: (row) =>
        row.breachedSla ? (
          <Pill tone="critical">SLA breached</Pill>
        ) : row.slaAtRisk ? (
          <Pill tone="caution">Overdue, no reply</Pill>
        ) : (
          <span className="whitespace-nowrap text-xs text-muted">{row.slaLabel}</span>
        ),
    },
    {
      key: 'assigneeName',
      header: 'Assignee',
      sortable: true,
      hideBelow: 'md',
      render: (row) =>
        row.assigneeName ? (
          <span
            className={cn(
              'text-sm',
              row.assigneeStaffId === staffId ? 'font-semibold text-ink' : 'text-muted',
            )}
          >
            {row.assigneeStaffId === staffId ? 'You' : row.assigneeName}
          </span>
        ) : (
          <Pill tone="caution">Unassigned</Pill>
        ),
    },
    {
      key: 'category',
      header: 'Category',
      sortable: true,
      hideBelow: 'lg',
      render: (row) => <span className="text-muted">{label(row.category)}</span>,
    },
    {
      key: 'lastReplyIso',
      header: 'Last reply',
      sortable: true,
      hideBelow: 'md',
      sortValue: (row) => row.lastReplyIso,
      render: (row) => <span className="whitespace-nowrap text-muted">{row.lastReplyLabel}</span>,
    },
  ];

  return (
    <>
      <FilterBar
        onReset={() =>
          apply({
            q: null,
            status: null,
            priority: null,
            category: null,
            assignee: null,
            breached: null,
          })
        }
        canReset={dirty}
        summary={
          <>
            {total.toLocaleString('en-CA')} ticket{total === 1 ? '' : 's'} match this filter
            {pageCount > 1 && ` · page ${page} of ${pageCount}`} · without a status filter the queue
            shows work in progress only. Breached tickets sort to the top.
          </>
        }
      >
        <SearchInput
          value={query}
          onChange={setQuery}
          label="Search tickets"
          placeholder="Number, subject or email"
          className="w-full sm:w-64"
        />
        <SelectFilter
          label="Status"
          value={filters.status}
          options={TICKET_STATUSES.map((status) => ({
            value: status,
            label: STATUS_LABEL[status] ?? status,
          }))}
          onChange={(value) => apply({ status: value || null })}
          anyLabel="Working queue"
        />
        <SelectFilter
          label="Priority"
          value={filters.priority}
          options={TICKET_PRIORITIES.map((priority) => ({ value: priority, label: priority }))}
          onChange={(value) => apply({ priority: value || null })}
          anyLabel="Any priority"
        />
        <SelectFilter
          label="Category"
          value={filters.category}
          options={TICKET_CATEGORIES.map((category) => ({
            value: category,
            label: label(category),
          }))}
          onChange={(value) => apply({ category: value || null })}
          anyLabel="Any category"
        />
        <SelectFilter
          label="Assignee"
          value={filters.assignee}
          options={[
            { value: staffId, label: 'Me' },
            { value: 'none', label: 'Unassigned' },
            ...assignees
              .filter((person) => person.id !== staffId)
              .map((person) => ({ value: person.id, label: person.name })),
          ]}
          onChange={(value) => apply({ assignee: value || null })}
          anyLabel="Anyone"
        />
        <SelectFilter
          label="SLA"
          value={filters.breached}
          options={[
            { value: '1', label: 'Breached only' },
            { value: '0', label: 'Within SLA' },
          ]}
          onChange={(value) => apply({ breached: value || null })}
          anyLabel="Any"
        />
      </FilterBar>

      <DataTable
        caption="Support tickets"
        rows={rows}
        columns={columns}
        rowKey={(row) => row.id}
        loading={pending}
        dense
        onRowClick={(row) => setOpenId(row.id)}
        isRowActive={(row) => row.id === openId}
        empty={{
          icon: <LifeBuoy className="h-5 w-5" aria-hidden="true" />,
          title: dirty ? 'No tickets match these filters' : 'The queue is empty',
          description: dirty
            ? 'Clear a filter, or switch the status filter away from the working queue to see resolved and closed tickets.'
            : 'Nothing is open, pending or on hold. Resolved and closed tickets are behind the status filter.',
        }}
      />

      {pageCount > 1 && (
        <nav
          aria-label="Ticket pages"
          className="mt-4 flex items-center justify-between gap-3 text-sm"
        >
          <button
            type="button"
            disabled={page <= 1 || pending}
            onClick={() => apply({ page: String(page - 1) })}
            className="btn-secondary px-3 py-2 text-xs disabled:opacity-40"
          >
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
            Previous
          </button>
          <span className="tabular-nums text-muted" aria-live="polite">
            Page {page} of {pageCount}
          </span>
          <button
            type="button"
            disabled={page >= pageCount || pending}
            onClick={() => apply({ page: String(page + 1) })}
            className="btn-secondary px-3 py-2 text-xs disabled:opacity-40"
          >
            Next
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </nav>
      )}

      <Drawer
        open={selected !== null}
        onClose={() => setOpenId(null)}
        title={selected ? `${selected.number} — ${selected.subject}` : 'Ticket'}
        description={selected ? `${selected.customerName} · ${selected.email}` : undefined}
        width="xl"
      >
        {selected && (
          <TicketThread
            row={selected}
            staffId={staffId}
            onChanged={() => startTransition(() => router.refresh())}
          />
        )}
      </Drawer>
    </>
  );
}

/**
 * The thread and its triage controls.
 *
 * The full conversation is fetched on open rather than shipped with every row —
 * a queue of fifty tickets would otherwise carry fifty conversations, most of
 * which nobody reads, and every one of them is customer correspondence.
 *
 * Internal notes and public replies share one table separated by
 * `SupportMessage.internal`. They are rendered differently and unmistakably: a
 * note that reads like a reply is how staff comments end up quoted back to a
 * customer.
 */
function TicketThread({
  row,
  staffId,
  onChanged,
}: {
  row: TicketRowView;
  staffId: string;
  onChanged: () => void;
}) {
  const [ticket, setTicket] = useState<ThreadTicket | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [nextStatus, setNextStatus] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/api/console/tickets/${row.id}`)
      .then(async (response) => {
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(payload?.error ?? `Could not load the thread (${response.status}).`);
        }
        return (await response.json()) as { ticket: ThreadTicket };
      })
      .then((payload) => {
        if (!cancelled) setTicket(payload.ticket);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [row.id]);

  async function patch(payload: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/console/tickets/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const failure = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(failure?.error ?? `That change was not saved (${response.status}).`);
        return;
      }
      const result = (await response.json()) as { ticket: ThreadTicket };
      setTicket(result.ticket);
      onChanged();
    } catch {
      setError('Could not reach the server. Nothing was changed.');
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/console/tickets/${row.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          body: text,
          internal,
          ...(nextStatus ? { status: nextStatus } : {}),
        }),
      });
      if (!response.ok) {
        const failure = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(failure?.error ?? `The message was not sent (${response.status}).`);
        return;
      }
      const result = (await response.json()) as { ticket: ThreadTicket };
      setTicket(result.ticket);
      setBody('');
      setNextStatus('');
      onChanged();
    } catch {
      setError('Could not reach the server. Copy your message before retrying.');
    } finally {
      setBusy(false);
    }
  }

  const current = ticket ?? null;

  return (
    <div className="space-y-6">
      <FieldGrid>
        <Field label="Status">
          <select
            value={current?.status ?? row.status}
            disabled={busy || loading}
            onChange={(event) => void patch({ status: event.target.value })}
            className="input py-1.5 text-sm disabled:opacity-60"
            aria-label="Ticket status"
          >
            {TICKET_STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABEL[status] ?? status}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Priority">
          <select
            value={current?.priority ?? row.priority}
            disabled={busy || loading}
            onChange={(event) => void patch({ priority: event.target.value })}
            className="input py-1.5 text-sm disabled:opacity-60"
            aria-label="Ticket priority"
          >
            {TICKET_PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {priority}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Assignee">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm">
              {current?.assigneeName ?? row.assigneeName ?? (
                <span className="text-faint">Unassigned</span>
              )}
            </span>
            {(current?.assigneeStaffId ?? row.assigneeStaffId) === staffId ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void patch({ assigneeStaffId: null })}
                className="btn-ghost px-2 py-1 text-xs"
              >
                Release
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => void patch({ assigneeStaffId: staffId })}
                className="btn-secondary px-2 py-1 text-xs"
              >
                Assign to me
              </button>
            )}
          </span>
        </Field>
        <Field label="Opened">{row.openedLabel}</Field>
        <Field label="Channel">{label(row.channel)}</Field>
        <Field label="Category">{label(row.category)}</Field>
        {row.userId && (
          <Field label="Account" wide>
            <Link
              href={`/console/customers/${row.userId}`}
              className="inline-flex items-center gap-1 text-brand-500 hover:text-brand-600"
            >
              <User className="h-3.5 w-3.5" aria-hidden="true" />
              Open the 360° record
            </Link>
          </Field>
        )}
      </FieldGrid>

      {row.breachedSla && (
        <p className="flex items-start gap-1.5 rounded-xl bg-danger/10 p-2.5 text-xs text-danger">
          <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          The first-response SLA was missed. That verdict was recorded when the first public reply
          landed and is deliberately not recalculated — lowering the priority now would not undo it.
        </p>
      )}

      {/* --- Thread --- */}
      <section aria-labelledby="thread">
        <h3 id="thread" className="mb-2 text-sm font-semibold text-ink">
          Conversation
        </h3>

        {loading ? (
          <p className="flex items-center gap-2 py-6 text-sm text-muted">
            <Loader2
              className="h-4 w-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            Loading the thread…
          </p>
        ) : current && current.messages.length > 0 ? (
          <ol className="space-y-3">
            {current.messages.map((message) => (
              <li
                key={message.id}
                className={cn(
                  'rounded-xl border p-3',
                  message.internal
                    ? 'border-warn/40 bg-warn/5'
                    : message.authorType === 'staff'
                      ? 'border-brand-500/30 bg-brand-500/5'
                      : 'border-line bg-raised',
                )}
              >
                <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
                  <p className="flex items-center gap-1.5 text-xs font-semibold text-ink">
                    {message.internal && (
                      <Lock className="h-3 w-3 text-warn" aria-label="Internal note" />
                    )}
                    {message.authorName}
                    <span className="font-normal text-faint">· {message.authorType}</span>
                  </p>
                  <p className="text-xs text-faint">
                    {new Date(message.createdAt).toLocaleString('en-CA')}
                  </p>
                </div>
                {message.internal && (
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-warn">
                    Internal — never shown to the customer
                  </p>
                )}
                <p className="whitespace-pre-wrap text-sm text-ink">{message.body}</p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="py-6 text-sm text-muted">This ticket has no messages.</p>
        )}
      </section>

      {/* --- Reply --- */}
      <section aria-labelledby="reply" className="rounded-xl border border-line p-3">
        <h3 id="reply" className="text-sm font-semibold text-ink">
          {internal ? 'Add an internal note' : 'Reply to the customer'}
        </h3>
        <p className="mt-0.5 text-xs text-muted">
          {internal
            ? 'Staff only. It does not stop the first-response clock and the customer never sees it.'
            : 'The first public reply stops the SLA clock and decides, once, whether it was breached.'}
        </p>

        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={4}
          maxLength={8000}
          disabled={busy}
          aria-label={internal ? 'Internal note' : 'Reply to the customer'}
          placeholder={internal ? 'Context for whoever picks this up next…' : 'Write your reply…'}
          className="input mt-2 resize-y text-sm disabled:opacity-60"
        />

        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={internal}
              onChange={(event) => setInternal(event.target.checked)}
              disabled={busy}
              className="h-3.5 w-3.5 rounded border-line accent-warn"
            />
            Internal note
          </label>

          <div className="flex items-center gap-2">
            <select
              value={nextStatus}
              disabled={busy}
              onChange={(event) => setNextStatus(event.target.value)}
              aria-label="Move to status when sending"
              className="input w-auto py-1.5 text-xs disabled:opacity-60"
            >
              <option value="">Leave status as is</option>
              {TICKET_STATUSES.map((status) => (
                <option key={status} value={status}>
                  Move to {STATUS_LABEL[status] ?? status}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void send()}
              disabled={busy || body.trim().length === 0}
              className="btn-primary px-3 py-2 text-xs"
            >
              {busy ? (
                <Loader2
                  className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <Send className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {internal ? 'Add note' : 'Send reply'}
            </button>
          </div>
        </div>
      </section>

      <p className="flex items-center gap-1.5 text-xs text-faint">
        <Clock className="h-3 w-3" aria-hidden="true" />
        Last reply {row.lastReplyLabel} · {row.messageCount} message
        {row.messageCount === 1 ? '' : 's'}
      </p>

      {error && (
        <p
          role="alert"
          className="flex items-start gap-1.5 rounded-xl bg-danger/10 p-2.5 text-xs text-danger"
        >
          <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}
    </div>
  );
}
