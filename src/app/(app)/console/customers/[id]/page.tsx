import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  Activity,
  BadgeCheck,
  Ban,
  Building2,
  Clock,
  Download,
  ExternalLink,
  FileText,
  LifeBuoy,
  ListChecks,
  Receipt,
  ShieldAlert,
  Star,
} from 'lucide-react';
import { db } from '@/lib/db';
import { getCustomerDetail } from '@/lib/crm/customers';
import { SubscriptionManager } from '@/components/console/subscription-manager';
import { getCustomerTimeline, type TimelineSource } from '@/lib/crm/activities';
import { STAFF_RANK } from '@/lib/crm/auth';
import { Card, Meter, PageHeader, StatusBadge } from '@/components/ui';
import { consoleGate } from '../../guard';
import {
  AccessDenied,
  Blank,
  Field,
  FieldGrid,
  InvoiceBadge,
  Kpi,
  Pill,
  RiskBadge,
  Section,
  StageBadge,
  count,
  day,
  dayTime,
  money,
  since,
  type Tone,
} from '../../ui';
import { CrmPanel } from './crm-panel';
import { NotesPanel } from './notes-panel';

export const dynamic = 'force-dynamic';

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }) {
  const gate = await consoleGate('support');
  if (!gate.ok) return { title: 'Customer' };

  const { id } = await params;
  const user = await db.user.findUnique({
    where: { id },
    select: { fullName: true, email: true },
  });
  return { title: user ? user.fullName || user.email : 'Customer' };
}

const SOURCE_TONE: Record<TimelineSource, Tone> = {
  crm: 'brand',
  product: 'neutral',
  support: 'caution',
  billing: 'positive',
};

const SOURCE_LABEL: Record<TimelineSource, string> = {
  crm: 'CRM',
  product: 'Product',
  support: 'Support',
  billing: 'Billing',
};

export default async function ConsoleCustomerPage({ params }: { params: Params }) {
  const gate = await consoleGate('support');
  if (!gate.ok) return <AccessDenied />;

  const { id } = await params;
  const now = new Date();

  // The detail read is deliberately read-only. `getCustomerDetail` computes the
  // quota without calling getQuota(), which would roll the billing window
  // forward — a support agent opening a record must not hand that customer a
  // fresh month of applications as a side effect of looking.
  const [detail, timeline, plans] = await Promise.all([
    getCustomerDetail(id, now),
    getCustomerTimeline(id, { limit: 40 }),
    // For the management panel's plan picker.
    db.plan.findMany({ orderBy: { sortOrder: 'asc' }, select: { code: true, name: true } }),
  ]);

  if (!detail) notFound();

  const owner = detail.crm.ownerStaffId
    ? await db.user.findUnique({
        where: { id: detail.crm.ownerStaffId },
        select: { fullName: true, email: true },
      })
    : null;

  const { profile, assessment, subscription, quota, usage, billing } = detail;
  const displayName = profile.fullName || profile.email;

  // Both gates happen to sit at billing_ops, but for different reasons, so they
  // are named for what they permit rather than collapsed into one flag.
  //
  //   canEditCrm  — the PATCH route requires billing_ops because lifecycle and
  //                 churn reason feed revenue reporting and doNotContact is a
  //                 CASL consent flag.
  //   canBill     — /console/invoices and the staff PDF route require
  //                 billing_ops. Support still SEES the invoice history here;
  //                 what they cannot do is pull the document or open the
  //                 book-wide invoice page, so those links are withheld rather
  //                 than offered and then refused.
  const canEditCrm = STAFF_RANK[gate.staff.role] >= STAFF_RANK.billing_ops;
  const canBill = STAFF_RANK[gate.staff.role] >= STAFF_RANK.billing_ops;

  const statuses = Object.entries(usage.applicationsByStatus).sort((a, b) => b[1] - a[1]);

  return (
    <>
      <PageHeader
        title={displayName}
        description={assessment.summary}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/console/tickets?userId=${profile.userId}`}
              className="btn-secondary px-3 py-2 text-xs"
            >
              <LifeBuoy className="h-3.5 w-3.5" aria-hidden="true" />
              Tickets
            </Link>
            {canBill && (
              <Link
                href={`/console/invoices?q=${encodeURIComponent(profile.email)}`}
                className="btn-secondary px-3 py-2 text-xs"
              >
                <Receipt className="h-3.5 w-3.5" aria-hidden="true" />
                Invoices
              </Link>
            )}
          </div>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <StageBadge view={assessment.view} />
        <RiskBadge risk={assessment.risk} />
        {detail.crm.vip && (
          <Pill tone="caution">
            <Star className="h-3 w-3 fill-current" aria-hidden="true" />
            VIP
          </Pill>
        )}
        {detail.crm.doNotContact && (
          <Pill tone="critical">
            <Ban className="h-3 w-3" aria-hidden="true" />
            Do not contact
          </Pill>
        )}
        {profile.anonymizedAt && (
          <Pill tone="neutral">Erased {day(profile.anonymizedAt)}</Pill>
        )}
        {profile.role !== 'member' && <Pill tone="brand">Staff · {profile.role}</Pill>}
        <span className="text-xs text-faint">
          Signed up {day(profile.signedUpAt)} · {since(profile.signedUpAt, now)}
        </span>
      </div>

      {/* Headline numbers, money first. */}
      <div className="mb-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label="Monthly revenue"
          value={money(subscription?.mrrCents ?? 0, subscription?.currency ?? 'CAD')}
          tone={subscription && subscription.mrrCents > 0 ? 'brand' : 'neutral'}
          hint={
            subscription
              ? `${subscription.planName} · billed ${subscription.interval}`
              : 'No subscription'
          }
        />
        <Kpi
          label="Lifetime value"
          value={money(billing.lifetimeValueCents)}
          hint="Cash collected, net of refunds."
        />
        <Kpi
          label="Outstanding"
          value={money(billing.outstandingCents)}
          tone={
            billing.overdueInvoices > 0
              ? 'critical'
              : billing.outstandingCents > 0
                ? 'caution'
                : 'positive'
          }
          hint={
            billing.overdueInvoices > 0
              ? `${count(billing.overdueInvoices)} invoice${billing.overdueInvoices === 1 ? '' : 's'} past due`
              : 'Nothing overdue.'
          }
        />
        <Kpi
          label="Health score"
          value={String(assessment.healthScore)}
          tone={
            assessment.risk === 'critical'
              ? 'critical'
              : assessment.risk === 'at_risk'
                ? 'caution'
                : 'positive'
          }
          hint={`${count(usage.applicationsLast30Days)} applications in the last 30 days`}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-8 lg:col-span-2">
          {/* --- Subscription and quota --- */}
          <Section
            id="subscription"
            title="Subscription and quota"
            description="Entitlement is read from the subscription only — never from the CRM lifecycle stage."
          >
            <Card className="p-5">
              {subscription ? (
                <>
                  <FieldGrid cols={3}>
                    <Field label="Plan">
                      {subscription.planName}{' '}
                      <span className="text-faint">({subscription.planCode})</span>
                    </Field>
                    <Field label="Status">
                      <StatusBadge status={subscription.status} />
                    </Field>
                    <Field label="Interval">{subscription.interval}</Field>
                    <Field label="Started">{day(subscription.startedAt)}</Field>
                    <Field label="Renews">
                      {day(subscription.renewsAt)}
                      {subscription.cancelAtPeriodEnd && (
                        <span className="ml-2 text-danger">Cancels at period end</span>
                      )}
                    </Field>
                    <Field label="Provider">{subscription.provider}</Field>
                    {subscription.trialEndsAt && (
                      <Field label="Trial ends">{day(subscription.trialEndsAt)}</Field>
                    )}
                    {subscription.graceEndsAt && (
                      <Field label="Grace ends">{day(subscription.graceEndsAt)}</Field>
                    )}
                    {subscription.suspendedAt && (
                      <Field label="Suspended">{day(subscription.suspendedAt)}</Field>
                    )}
                    {subscription.bonusApplications > 0 && (
                      <Field label="Bonus applications">+{subscription.bonusApplications}</Field>
                    )}
                  </FieldGrid>

                  {quota && (
                    <div className="mt-5 border-t border-line pt-4">
                      <Meter
                        used={quota.used}
                        total={quota.limit}
                        label={`Applications this window (${day(quota.periodStart)} – ${day(quota.periodEnd)})`}
                      />
                      <p className="mt-2 text-xs text-muted">
                        {quota.remaining} of {quota.limit} remaining.{' '}
                        {quota.windowExpired
                          ? 'This window has elapsed — the counter resets on the customer’s next application, not on this page load.'
                          : `Resets ${day(quota.periodEnd)}.`}
                      </p>
                    </div>
                  )}

                  {/* Staff management: billing_ops-gated server actions, every
                      change reason-required and written to the audit log. */}
                  <SubscriptionManager
                    userId={detail.profile.userId}
                    currentPlanCode={subscription.planCode}
                    currentInterval={subscription.interval}
                    cancelAtPeriodEnd={subscription.cancelAtPeriodEnd}
                    plans={plans}
                  />
                </>
              ) : (
                <Blank>
                  This account has never subscribed. Applications, agents and scans are all
                  unavailable to them.
                </Blank>
              )}
            </Card>
          </Section>

          {/* --- Why this score --- */}
          {assessment.reasons.length > 0 && (
            <Section
              id="risk"
              title="Why this account is flagged"
              description="Every rule that fired, with the numbers behind it. Weights add up to the risk score."
            >
              <Card className="divide-y divide-line p-0">
                {assessment.reasons.map((reason) => (
                  <div key={reason.code} className="flex items-start gap-3 p-4">
                    <ShieldAlert
                      className={`mt-0.5 h-4 w-4 shrink-0 ${
                        reason.weight >= 3 ? 'text-danger' : 'text-warn'
                      }`}
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-ink">{reason.label}</p>
                      <p className="mt-0.5 text-sm text-muted">{reason.detail}</p>
                    </div>
                    <Pill tone={reason.weight >= 3 ? 'critical' : 'caution'}>
                      +{reason.weight}
                    </Pill>
                  </div>
                ))}
                <p className="px-4 py-3 text-xs text-faint">
                  Risk score {assessment.riskScore} · at risk from 2, critical from 5.
                </p>
              </Card>
            </Section>
          )}

          {/* --- Product activity --- */}
          <Section
            id="activity"
            title="Application activity"
            description="What the customer has actually got out of the product."
          >
            <div className="mb-4 grid gap-4 sm:grid-cols-4">
              <Kpi label="Applications" value={count(usage.applicationsTotal)} icon={FileText} />
              <Kpi label="Agents" value={count(usage.agents)} icon={Activity} />
              <Kpi label="Resumes" value={count(usage.resumes)} icon={FileText} />
              <Kpi label="Interview preps" value={count(usage.interviews)} icon={ListChecks} />
            </div>

            <Card className="overflow-hidden p-0">
              {statuses.length > 0 && (
                <div className="flex flex-wrap gap-2 border-b border-line p-4">
                  {statuses.map(([status, total]) => (
                    <span key={status} className="flex items-center gap-1.5">
                      <StatusBadge status={status} />
                      <span className="text-xs font-semibold tabular-nums text-muted">{total}</span>
                    </span>
                  ))}
                </div>
              )}

              {detail.applications.length === 0 ? (
                <Blank>No applications have been created on this account.</Blank>
              ) : (
                <ul className="divide-y divide-line">
                  {detail.applications.map((application) => (
                    <li key={application.id} className="flex items-start gap-3 p-4">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-ink">
                          {application.title}
                        </p>
                        <p className="truncate text-xs text-muted">
                          {application.company} · score {application.matchScore}
                          {application.failureReason && (
                            <span className="text-danger"> · {application.failureReason}</span>
                          )}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <StatusBadge status={application.status} />
                        <span className="text-xs text-faint">
                          {since(application.appliedAt ?? application.createdAt, now)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </Section>

          {/* --- Invoices --- */}
          <Section
            id="invoices"
            title="Invoice history"
            description={
              canBill
                ? 'The ten most recent documents. Only issued invoices have a PDF.'
                : 'The ten most recent documents. Downloading one needs billing operations access.'
            }
            action={
              canBill ? (
                <Link
                  href={`/console/invoices?q=${encodeURIComponent(profile.email)}`}
                  className="text-sm font-medium text-brand-500 hover:text-brand-600"
                >
                  All invoices
                </Link>
              ) : undefined
            }
          >
            <Card className="overflow-hidden p-0">
              {billing.invoices.length === 0 ? (
                <Blank>No invoice has been raised for this account.</Blank>
              ) : (
                <div className="scroll-x">
                  <table className="w-full border-collapse text-sm">
                    <caption className="sr-only">Recent invoices for {displayName}</caption>
                    <thead>
                      <tr className="border-b border-line text-xs uppercase tracking-wide text-faint">
                        <th scope="col" className="px-4 py-2.5 text-left font-semibold">
                          Number
                        </th>
                        <th scope="col" className="px-4 py-2.5 text-left font-semibold">
                          Status
                        </th>
                        <th scope="col" className="px-4 py-2.5 text-right font-semibold">
                          Total
                        </th>
                        <th scope="col" className="px-4 py-2.5 text-right font-semibold">
                          Due
                        </th>
                        <th scope="col" className="px-4 py-2.5 text-left font-semibold">
                          Issued
                        </th>
                        <th scope="col" className="px-4 py-2.5 text-right font-semibold">
                          <span className="sr-only">PDF</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {billing.invoices.map((invoice) => {
                        const overdue =
                          invoice.status === 'open' &&
                          invoice.dueAt !== null &&
                          invoice.dueAt < now;
                        return (
                          <tr key={invoice.id} className="border-b border-line last:border-0">
                            <td className="px-4 py-3 font-semibold text-ink">
                              {invoice.number ?? (
                                <span className="text-faint">Draft {invoice.id.slice(-6)}</span>
                              )}
                            </td>
                            <td className="px-4 py-3">
                              <InvoiceBadge status={overdue ? 'past_due' : invoice.status} />
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums text-ink">
                              {money(invoice.totalCents, invoice.currency)}
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums">
                              {invoice.amountDueCents > 0 ? (
                                <span className={overdue ? 'font-semibold text-danger' : 'text-ink'}>
                                  {money(invoice.amountDueCents, invoice.currency)}
                                </span>
                              ) : (
                                <span className="text-faint">—</span>
                              )}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 text-muted">
                              {day(invoice.issuedAt)}
                            </td>
                            <td className="px-4 py-3 text-right">
                              {canBill && invoice.number ? (
                                <a
                                  href={`/console/invoices/${invoice.id}/pdf`}
                                  className="btn-ghost px-2 py-1 text-xs"
                                >
                                  <Download className="h-3.5 w-3.5" aria-hidden="true" />
                                  <span className="sr-only">
                                    Download invoice {invoice.number} as PDF
                                  </span>
                                  PDF
                                </a>
                              ) : (
                                <span className="text-xs text-faint">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            {billing.payments.length > 0 && (
              <Card className="mt-4 p-4">
                <h3 className="mb-3 text-sm font-semibold text-ink">Recent payments</h3>
                <ul className="space-y-2 text-sm">
                  {billing.payments.slice(0, 5).map((payment) => (
                    <li key={payment.id} className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate text-muted">
                        {payment.provider} · {payment.method.replace(/_/g, ' ')} ·{' '}
                        {day(payment.createdAt)}
                        {payment.failureCode && (
                          <span className="text-danger"> · {payment.failureCode}</span>
                        )}
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="tabular-nums text-ink">
                          {money(payment.amountCents, payment.currency)}
                        </span>
                        <InvoiceBadge
                          status={payment.status === 'succeeded' ? 'paid' : payment.status}
                        />
                      </span>
                    </li>
                  ))}
                </ul>
                {billing.defaultPaymentMethod && (
                  <p className="mt-3 border-t border-line pt-3 text-xs text-muted">
                    Default card: {billing.defaultPaymentMethod.brand ?? 'card'} ····
                    {billing.defaultPaymentMethod.last4 ?? '????'}
                    {billing.defaultPaymentMethod.expMonth && billing.defaultPaymentMethod.expYear
                      ? ` · expires ${String(billing.defaultPaymentMethod.expMonth).padStart(2, '0')}/${billing.defaultPaymentMethod.expYear}`
                      : ''}{' '}
                    · {billing.defaultPaymentMethod.status}
                  </p>
                )}
              </Card>
            )}
          </Section>

          {/* --- Timeline --- */}
          <Section
            id="timeline"
            title="Timeline"
            description="Product events, support replies, billing milestones and staff activity, merged newest first."
          >
            <Card className="overflow-hidden p-0">
              {timeline.length === 0 ? (
                <Blank>Nothing has happened on this account yet.</Blank>
              ) : (
                <ol className="divide-y divide-line">
                  {timeline.map((entry) => (
                    <li key={entry.id} className="flex gap-3 p-4">
                      <div className="mt-0.5 shrink-0">
                        <Pill tone={SOURCE_TONE[entry.source]}>{SOURCE_LABEL[entry.source]}</Pill>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-ink">
                          {entry.href ? (
                            <Link href={entry.href} className="hover:text-brand-600">
                              {entry.title}
                              <ExternalLink
                                className="ml-1 inline h-3 w-3 align-baseline"
                                aria-hidden="true"
                              />
                            </Link>
                          ) : (
                            entry.title
                          )}
                          {entry.visibility === 'internal' && (
                            <span className="ml-2 align-middle">
                              <Pill tone="caution">Internal</Pill>
                            </span>
                          )}
                        </p>
                        {entry.body && (
                          <p className="mt-0.5 whitespace-pre-wrap text-sm text-muted">
                            {entry.body}
                          </p>
                        )}
                        <p className="mt-1 flex items-center gap-1.5 text-xs text-faint">
                          <Clock className="h-3 w-3" aria-hidden="true" />
                          {dayTime(entry.occurredAt)} · {entry.actor.name}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          </Section>
        </div>

        {/* --- Sidebar --- */}
        <div className="space-y-6">
          <Card className="p-4">
            <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
              <BadgeCheck className="h-4 w-4 text-muted" aria-hidden="true" />
              Profile
            </h3>
            <FieldGrid>
              <Field label="Email" wide>
                <a href={`mailto:${profile.email}`} className="text-brand-500 hover:text-brand-600">
                  {profile.email}
                </a>
              </Field>
              <Field label="Phone">{profile.phone ?? '—'}</Field>
              <Field label="Location">
                {profile.city ? `${profile.city}, ${profile.country}` : profile.country}
              </Field>
              <Field label="Work authorization">{profile.workAuth ?? '—'}</Field>
              <Field label="Onboarded">{day(profile.onboardedAt)}</Field>
              <Field label="Headline" wide>
                {profile.headline ?? '—'}
              </Field>
              {profile.linkedinUrl && (
                <Field label="LinkedIn" wide>
                  <a
                    href={profile.linkedinUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="break-all text-brand-500 hover:text-brand-600"
                  >
                    {profile.linkedinUrl}
                  </a>
                </Field>
              )}
              <Field label="Last active" wide>
                {usage.lastActivityAt
                  ? `${since(usage.lastActivityAt, now)} (${dayTime(usage.lastActivityAt)})`
                  : 'No product activity recorded'}
              </Field>
              <Field label="User id" wide>
                <code className="break-all font-mono text-xs text-faint">{profile.userId}</code>
              </Field>
            </FieldGrid>
          </Card>

          <CrmPanel
            userId={profile.userId}
            staffId={gate.staff.id}
            staffName={gate.staff.fullName || gate.staff.email}
            canEdit={canEditCrm}
            stage={detail.crm.lifecycleStage}
            segment={detail.crm.segment}
            source={detail.crm.source}
            campaign={detail.crm.campaign}
            ownerStaffId={detail.crm.ownerStaffId}
            ownerName={owner ? owner.fullName || owner.email : null}
            vip={detail.crm.vip}
            doNotContact={detail.crm.doNotContact}
            churnReason={detail.crm.churnReason}
            metricsRefreshedLabel={
              detail.crm.metricsRefreshedAt ? since(detail.crm.metricsRefreshedAt, now) : 'never'
            }
          />

          <NotesPanel
            userId={profile.userId}
            authorName={gate.staff.fullName || gate.staff.email}
            notes={detail.notes.map((note) => ({
              id: note.id,
              staffName: note.staffName,
              body: note.body,
              pinned: note.pinned,
              createdLabel: dayTime(note.createdAt),
            }))}
          />

          <Card className="p-4">
            <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
              <ListChecks className="h-4 w-4 text-muted" aria-hidden="true" />
              Open tasks
            </h3>
            {detail.tasks.length === 0 ? (
              <p className="text-sm text-muted">No follow-ups are outstanding.</p>
            ) : (
              <ul className="space-y-2">
                {detail.tasks.map((task) => (
                  <li key={task.id} className="flex items-start justify-between gap-2 text-sm">
                    <span className="min-w-0 text-ink">{task.title}</span>
                    <span className="shrink-0 text-xs text-faint">
                      {task.dueAt ? day(task.dueAt) : task.priority}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {detail.tickets.length > 0 && (
            <Card className="p-4">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
                <LifeBuoy className="h-4 w-4 text-muted" aria-hidden="true" />
                Recent tickets
              </h3>
              <ul className="space-y-2">
                {detail.tickets.slice(0, 6).map((ticket) => (
                  <li key={ticket.id}>
                    <Link
                      href={`/console/tickets?q=${encodeURIComponent(ticket.number)}`}
                      className="block text-sm text-ink hover:text-brand-600"
                    >
                      <span className="font-mono text-xs text-faint">{ticket.number}</span>{' '}
                      {ticket.subject}
                    </Link>
                    <p className="mt-0.5 flex items-center gap-1.5 text-xs text-faint">
                      {ticket.status} · {ticket.priority}
                      {ticket.breachedSla && <Pill tone="critical">SLA breached</Pill>}
                    </p>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {detail.crm.internalNotes && (
            <Card className="p-4">
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
                <Building2 className="h-4 w-4 text-muted" aria-hidden="true" />
                Account notes
              </h3>
              <p className="whitespace-pre-wrap text-sm text-muted">{detail.crm.internalNotes}</p>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
