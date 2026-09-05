/**
 * Staff-side customer queries: the console list and the 360° detail view.
 *
 * Two rules shape everything here.
 *
 * 1. THE CONSOLE MUST NOT MUTATE THE CUSTOMER'S PRODUCT STATE. In particular
 *    it never calls getQuota(), which rolls the billing window forward and
 *    resets applicationsUsed as a side effect of being read. A support agent
 *    opening a record must not silently hand that customer a fresh month of
 *    applications. Quota is computed read-only here instead.
 *
 * 2. STAGE AND RISK ARE COMPUTED LIVE FOR DISPLAY. Customer.lifecycleStage,
 *    riskLevel, mrrCents and lifetimeValueCents are declared caches; a badge
 *    rendered from a cache that a nightly job forgot to run is worse than no
 *    badge. Rows therefore carry a freshly computed assessment, and
 *    refreshCustomerMetrics() writes the caches back so list filtering and
 *    reporting converge on the same answer.
 */

import { db } from '../db';
import { quantitiesForMany, quantityFor } from '@/lib/entitlements/service';
import { monthlyEquivalent } from '../subscription';
import { parseJson } from '../types';
import {
  type LifecycleAssessment,
  type LifecycleStage,
  type RiskLevel,
  computeLifecycle,
  isLifecycleStage,
  isRiskLevel,
} from './lifecycle';
import type { StaffContext } from './auth';

const DAY_MS = 86_400_000;

/**
 * How many candidate rows a risk-filtered query will scan before giving up on
 * exactness. Risk is a computed value, so it cannot be a SQL predicate; the
 * alternative is filtering on the nightly cache, which quietly returns the
 * wrong customers. Scanning is correct up to this many matches and reports
 * `truncated` beyond it, which is a limit staff can see rather than an error
 * they cannot.
 */
export const RISK_SCAN_CAP = 2000;

export const CUSTOMER_SORTS = [
  'recent',
  'oldest',
  'name',
  'mrr',
  'activity',
  'health',
] as const;
export type CustomerSort = (typeof CUSTOMER_SORTS)[number];

export function isCustomerSort(value: string): value is CustomerSort {
  return (CUSTOMER_SORTS as readonly string[]).includes(value);
}

export interface CustomerListFilters {
  /** Matches email, full name or city. */
  search?: string;
  stage?: LifecycleStage;
  risk?: RiskLevel;
  planCode?: string;
  ownerStaffId?: string;
  segment?: string;
  vip?: boolean;
  signedUpAfter?: Date;
  signedUpBefore?: Date;
  /** Minimum normalised monthly revenue, in cents. */
  minMrrCents?: number;
  sort?: CustomerSort;
  page?: number;
  pageSize?: number;
}

export interface CustomerListRow {
  /** The console's customer key is the User id — Customer rows are created lazily. */
  userId: string;
  customerId: string | null;
  email: string;
  fullName: string;
  city: string | null;
  country: string;
  signedUpAt: Date;
  anonymized: boolean;

  planCode: string | null;
  planName: string | null;
  interval: string | null;
  subscriptionStatus: string | null;
  /** Normalised monthly revenue in cents — annual and quarterly divided down. */
  mrrCents: number;
  lifetimeValueCents: number;

  applicationsUsed: number;
  applicationsLimit: number;
  applicationsLast30Days: number;
  lastActivityAt: Date | null;

  stage: LifecycleStage;
  risk: RiskLevel;
  view: LifecycleAssessment['view'];
  healthScore: number;
  riskReasons: LifecycleAssessment['reasons'];

  ownerStaffId: string | null;
  segment: string;
  vip: boolean;
  doNotContact: boolean;
  openTickets: number;
  metricsRefreshedAt: Date | null;
}

export interface CustomerListResult {
  rows: CustomerListRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  /** True when a risk filter hit RISK_SCAN_CAP and the result may be partial. */
  truncated: boolean;
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

// --- Shared shapes ----------------------------------------------------------

const listSelect = {
  id: true,
  email: true,
  fullName: true,
  city: true,
  country: true,
  createdAt: true,
  anonymizedAt: true,
  subscription: {
    select: {
      status: true,
      interval: true,
      periodStart: true,
      periodEnd: true,
      applicationsUsed: true,
      bonusApplications: true,
      trialEndsAt: true,
      graceEndsAt: true,
      cancelAtPeriodEnd: true,
      plan: {
        select: {
          code: true,
          name: true,
          applicationsPerMonth: true,
          monthlyPriceCents: true,
          quarterlyPriceCents: true,
          annualPriceCents: true,
        },
      },
    },
  },
  customer: {
    select: {
      id: true,
      ownerStaffId: true,
      segment: true,
      vip: true,
      doNotContact: true,
      lifetimeValueCents: true,
      metricsRefreshedAt: true,
    },
  },
} as const;

type ListUser = {
  id: string;
  email: string;
  fullName: string;
  city: string | null;
  country: string;
  createdAt: Date;
  anonymizedAt: Date | null;
  subscription: {
    status: string;
    interval: string;
    periodStart: Date;
    periodEnd: Date;
    applicationsUsed: number;
    bonusApplications: number;
    trialEndsAt: Date | null;
    graceEndsAt: Date | null;
    cancelAtPeriodEnd: boolean;
    plan: {
      code: string;
      name: string;
      applicationsPerMonth: number;
      monthlyPriceCents: number;
      quarterlyPriceCents: number;
      annualPriceCents: number;
    };
  } | null;
  customer: {
    id: string;
    ownerStaffId: string | null;
    segment: string;
    vip: boolean;
    doNotContact: boolean;
    lifetimeValueCents: number;
    metricsRefreshedAt: Date | null;
  } | null;
};

type SubscriptionShape = NonNullable<ListUser['subscription']>;

/**
 * Normalised monthly revenue for one subscription, in cents.
 *
 * Only statuses that are actually billing count. A trial is worth nothing
 * until it converts, and a canceled or suspended subscription is worth nothing
 * at all — counting either would inflate MRR with money nobody is paying.
 */
export function mrrForSubscription(subscription: SubscriptionShape | null): number {
  if (!subscription) return 0;
  const billing = ['active', 'past_due', 'grace'];
  if (!billing.includes(subscription.status)) return 0;
  const interval =
    subscription.interval === 'annual' || subscription.interval === 'quarterly'
      ? subscription.interval
      : 'monthly';
  return monthlyEquivalent(subscription.plan, interval);
}

/** The monthly application allowance actually in force: plan plus bonuses. */
export function allowanceFor(subscription: SubscriptionShape | null): number {
  if (!subscription) return 0;
  return subscription.plan.applicationsPerMonth + subscription.bonusApplications;
}

// --- Enrichment -------------------------------------------------------------

interface Aggregates {
  lastActivityAt: Map<string, Date>;
  applications30d: Map<string, number>;
  failedPayments30d: Map<string, number>;
  overdueInvoices: Map<string, number>;
  openTickets: Map<string, number>;
  lifetimeValue: Map<string, number>;
  /**
   * Stage 15: the resolved `applications_per_month` entitlement per user (a
   * comp, a pilot, the plan - whichever is highest; the free baseline when
   * no row applies). The person's own rows only: an organization's pooled
   * licence is not folded into the list, and the detail page says so.
   */
  entitledApplications: Map<string, number>;
}

/**
 * Fetch every per-customer aggregate the risk rules need for a whole page in
 * six grouped queries — not six per row. The N+1 version of this function is
 * the difference between a console that opens instantly and one nobody uses.
 */
async function loadAggregates(userIds: string[], now: Date): Promise<Aggregates> {
  const empty: Aggregates = {
    lastActivityAt: new Map(),
    applications30d: new Map(),
    failedPayments30d: new Map(),
    overdueInvoices: new Map(),
    openTickets: new Map(),
    lifetimeValue: new Map(),
    entitledApplications: new Map(),
  };
  if (userIds.length === 0) return empty;

  const since = new Date(now.getTime() - 30 * DAY_MS);

  const [activity, applications, failures, overdue, tickets, invoices, entitled] = await Promise.all([
    db.activityEvent.groupBy({
      by: ['userId'],
      where: { userId: { in: userIds } },
      _max: { createdAt: true },
    }),
    db.application.groupBy({
      by: ['userId'],
      where: { userId: { in: userIds }, createdAt: { gte: since } },
      _count: { _all: true },
    }),
    db.payment.groupBy({
      by: ['userId'],
      where: { userId: { in: userIds }, status: 'failed', createdAt: { gte: since } },
      _count: { _all: true },
    }),
    db.invoice.groupBy({
      by: ['userId'],
      where: { userId: { in: userIds }, status: 'open', dueAt: { lt: now } },
      _count: { _all: true },
    }),
    db.supportTicket.groupBy({
      by: ['userId'],
      where: { userId: { in: userIds }, status: { in: ['open', 'pending', 'on_hold'] } },
      _count: { _all: true },
    }),
    // Lifetime value is cash collected less cash returned, over every invoice
    // that was not voided. Void invoices never represented money.
    db.invoice.groupBy({
      by: ['userId'],
      where: { userId: { in: userIds }, status: { not: 'void' } },
      _sum: { amountPaidCents: true, amountRefundedCents: true },
    }),
    quantitiesForMany(db, userIds, 'applications_per_month', now),
  ]);

  for (const row of activity) {
    if (row._max.createdAt) empty.lastActivityAt.set(row.userId, row._max.createdAt);
  }
  for (const row of applications) empty.applications30d.set(row.userId, row._count._all);
  for (const row of failures) empty.failedPayments30d.set(row.userId, row._count._all);
  for (const row of overdue) empty.overdueInvoices.set(row.userId, row._count._all);
  for (const row of tickets) {
    if (row.userId) empty.openTickets.set(row.userId, row._count._all);
  }
  for (const row of invoices) {
    const paid = row._sum.amountPaidCents ?? 0;
    const refunded = row._sum.amountRefundedCents ?? 0;
    empty.lifetimeValue.set(row.userId, paid - refunded);
  }
  empty.entitledApplications = entitled;

  return empty;
}

/** The list's monthly allowance: the entitlement (plus the subscription's bonus), the plan's column only when no entitlement was read. */
function listAllowance(user: ListUser, aggregates: Aggregates): number {
  const entitled = aggregates.entitledApplications.get(user.id);
  if (entitled === undefined) return allowanceFor(user.subscription);
  return entitled + (user.subscription?.bonusApplications ?? 0);
}

function assess(user: ListUser, aggregates: Aggregates, now: Date): LifecycleAssessment {
  const subscription = user.subscription;
  return computeLifecycle({
    now,
    signedUpAt: user.createdAt,
    subscriptionStatus: subscription?.status ?? null,
    cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
    trialEndsAt: subscription?.trialEndsAt ?? null,
    graceEndsAt: subscription?.graceEndsAt ?? null,
    periodStart: subscription?.periodStart ?? null,
    periodEnd: subscription?.periodEnd ?? null,
    applicationsUsed: subscription?.applicationsUsed ?? 0,
    applicationsLimit: listAllowance(user, aggregates),
    lastActivityAt: aggregates.lastActivityAt.get(user.id) ?? null,
    failedPaymentsLast30Days: aggregates.failedPayments30d.get(user.id) ?? 0,
    overdueInvoices: aggregates.overdueInvoices.get(user.id) ?? 0,
    applicationsLast30Days: aggregates.applications30d.get(user.id) ?? 0,
  });
}

function toRow(user: ListUser, aggregates: Aggregates, now: Date): CustomerListRow {
  const subscription = user.subscription;
  const assessment = assess(user, aggregates, now);

  return {
    userId: user.id,
    customerId: user.customer?.id ?? null,
    email: user.email,
    fullName: user.fullName,
    city: user.city,
    country: user.country,
    signedUpAt: user.createdAt,
    anonymized: user.anonymizedAt !== null,

    planCode: subscription?.plan.code ?? null,
    planName: subscription?.plan.name ?? null,
    interval: subscription?.interval ?? null,
    subscriptionStatus: subscription?.status ?? null,
    mrrCents: mrrForSubscription(subscription),
    lifetimeValueCents:
      aggregates.lifetimeValue.get(user.id) ?? user.customer?.lifetimeValueCents ?? 0,

    applicationsUsed: subscription?.applicationsUsed ?? 0,
    applicationsLimit: listAllowance(user, aggregates),
    applicationsLast30Days: aggregates.applications30d.get(user.id) ?? 0,
    lastActivityAt: aggregates.lastActivityAt.get(user.id) ?? null,

    stage: assessment.stage,
    risk: assessment.risk,
    view: assessment.view,
    healthScore: assessment.healthScore,
    riskReasons: assessment.reasons,

    ownerStaffId: user.customer?.ownerStaffId ?? null,
    segment: user.customer?.segment ?? 'self_serve',
    vip: user.customer?.vip ?? false,
    doNotContact: user.customer?.doNotContact ?? false,
    openTickets: aggregates.openTickets.get(user.id) ?? 0,
    metricsRefreshedAt: user.customer?.metricsRefreshedAt ?? null,
  };
}

// --- Filtering --------------------------------------------------------------

/**
 * Translate a lifecycle stage into a subscription-status predicate.
 *
 * Filtering on the cached Customer.lifecycleStage column would return whatever
 * last night's job believed. Filtering on the status the stage is *derived
 * from* is exact and needs no cache at all.
 */
function stageWhere(stage: LifecycleStage) {
  switch (stage) {
    case 'active':
      return { subscription: { status: 'active' } };
    case 'trial':
      return { subscription: { status: 'trialing' } };
    case 'past_due':
      return { subscription: { status: { in: ['past_due', 'grace'] } } };
    case 'churned':
      return { subscription: { status: { in: ['canceled', 'suspended'] } } };
    case 'lead':
      // No subscription at all, or a status outside the known set.
      return {
        OR: [
          { subscription: { is: null } },
          {
            subscription: {
              status: {
                notIn: ['active', 'trialing', 'past_due', 'grace', 'canceled', 'suspended'],
              },
            },
          },
        ],
      };
  }
}

/**
 * Filter on a Customer column whose value is a schema default.
 *
 * Customer rows are created lazily, so "not VIP" and "self-serve" describe
 * every account that has no CRM row at all. A plain `{ customer: { vip: false } }`
 * matches only rows that exist and would quietly hide most of the book — the
 * kind of filter bug that makes staff distrust the whole list.
 */
function defaultAware(field: string, value: unknown, isSchemaDefault: boolean) {
  const direct = { customer: { [field]: value } };
  if (!isSchemaDefault) return direct;
  return { OR: [direct, { customer: { is: null } }] };
}

function buildWhere(filters: CustomerListFilters) {
  const and: Record<string, unknown>[] = [];

  if (filters.search) {
    const q = filters.search.trim();
    if (q) {
      // PostgreSQL's LIKE is case-sensitive, so the search must say so
      // explicitly. (SQLite's was case-insensitive for ASCII by default, which
      // is why this was absent before the Stage 01 migration — a silent
      // behaviour change, not a syntax one.)
      and.push({
        OR: [
          { email: { contains: q, mode: 'insensitive' } },
          { fullName: { contains: q, mode: 'insensitive' } },
          { city: { contains: q, mode: 'insensitive' } },
        ],
      });
    }
  }

  if (filters.stage) and.push(stageWhere(filters.stage) as Record<string, unknown>);
  if (filters.planCode) and.push({ subscription: { plan: { code: filters.planCode } } });
  // An owner filter implies a CRM record exists, so it needs no null branch.
  if (filters.ownerStaffId) and.push({ customer: { ownerStaffId: filters.ownerStaffId } });
  if (filters.segment) {
    and.push(defaultAware('segment', filters.segment, filters.segment === 'self_serve'));
  }
  if (filters.vip !== undefined) {
    and.push(defaultAware('vip', filters.vip, filters.vip === false));
  }

  if (filters.signedUpAfter || filters.signedUpBefore) {
    and.push({
      createdAt: {
        ...(filters.signedUpAfter ? { gte: filters.signedUpAfter } : {}),
        ...(filters.signedUpBefore ? { lte: filters.signedUpBefore } : {}),
      },
    });
  }

  // Revenue is derived from plan price and interval, so a cents threshold maps
  // onto "which plans clear this bar at this interval" rather than a column.
  if (filters.minMrrCents !== undefined && filters.minMrrCents > 0) {
    and.push({ customer: { mrrCents: { gte: filters.minMrrCents } } });
  }

  return and.length > 0 ? { AND: and } : {};
}

function orderFor(sort: CustomerSort) {
  switch (sort) {
    case 'oldest':
      return [{ createdAt: 'asc' as const }];
    case 'name':
      return [{ fullName: 'asc' as const }, { createdAt: 'desc' as const }];
    case 'mrr':
      // Cache first (exact when refreshed), plan price as the tie-break so the
      // ordering is still sensible on a database whose caches were never run.
      return [
        { customer: { mrrCents: 'desc' as const } },
        { subscription: { plan: { monthlyPriceCents: 'desc' as const } } },
        { createdAt: 'desc' as const },
      ];
    case 'activity':
      return [{ customer: { lastActivityAt: 'desc' as const } }, { createdAt: 'desc' as const }];
    case 'health':
      return [{ customer: { healthScore: 'asc' as const } }, { createdAt: 'desc' as const }];
    case 'recent':
    default:
      return [{ createdAt: 'desc' as const }];
  }
}

/** In-memory ordering, used only on the risk-filtered path. */
function sortRows(rows: CustomerListRow[], sort: CustomerSort): CustomerListRow[] {
  const byRecent = (a: CustomerListRow, b: CustomerListRow) =>
    b.signedUpAt.getTime() - a.signedUpAt.getTime();

  const sorted = [...rows];
  switch (sort) {
    case 'oldest':
      return sorted.sort((a, b) => a.signedUpAt.getTime() - b.signedUpAt.getTime());
    case 'name':
      return sorted.sort((a, b) => a.fullName.localeCompare(b.fullName) || byRecent(a, b));
    case 'mrr':
      return sorted.sort((a, b) => b.mrrCents - a.mrrCents || byRecent(a, b));
    case 'activity':
      return sorted.sort(
        (a, b) =>
          (b.lastActivityAt?.getTime() ?? 0) - (a.lastActivityAt?.getTime() ?? 0) || byRecent(a, b),
      );
    case 'health':
      return sorted.sort((a, b) => a.healthScore - b.healthScore || byRecent(a, b));
    case 'recent':
    default:
      return sorted.sort(byRecent);
  }
}

// --- The list ---------------------------------------------------------------

/**
 * The console customer list: search, filter, sort, paginate.
 *
 * Two execution paths. Without a risk filter the database does the work and
 * pagination is a LIMIT/OFFSET. With one, risk has to be computed per row
 * first, so the query scans up to RISK_SCAN_CAP matching customers, assesses
 * them, then filters, sorts and pages in memory — exact rather than
 * cache-approximate, and honest about the cap via `truncated`.
 */
export async function listCustomers(
  filters: CustomerListFilters = {},
  now: Date = new Date(),
): Promise<CustomerListResult> {
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(filters.pageSize ?? DEFAULT_PAGE_SIZE)));
  const sort = filters.sort ?? 'recent';
  const where = buildWhere(filters);

  if (filters.risk) {
    const candidates = (await db.user.findMany({
      where,
      select: listSelect,
      orderBy: [{ createdAt: 'desc' }],
      take: RISK_SCAN_CAP + 1,
    })) as ListUser[];

    const truncated = candidates.length > RISK_SCAN_CAP;
    const scanned = truncated ? candidates.slice(0, RISK_SCAN_CAP) : candidates;

    const aggregates = await loadAggregates(
      scanned.map((u) => u.id),
      now,
    );
    const matched = sortRows(
      scanned.map((u) => toRow(u, aggregates, now)).filter((row) => row.risk === filters.risk),
      sort,
    );

    const start = (page - 1) * pageSize;
    return {
      rows: matched.slice(start, start + pageSize),
      total: matched.length,
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(matched.length / pageSize)),
      truncated,
    };
  }

  const [total, users] = await Promise.all([
    db.user.count({ where }),
    db.user.findMany({
      where,
      select: listSelect,
      orderBy: orderFor(sort),
      skip: (page - 1) * pageSize,
      take: pageSize,
    }) as Promise<ListUser[]>,
  ]);

  const aggregates = await loadAggregates(
    users.map((u) => u.id),
    now,
  );

  return {
    rows: users.map((u) => toRow(u, aggregates, now)),
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    truncated: false,
  };
}

// --- The CRM shell ----------------------------------------------------------

/**
 * Ensure a Customer row exists for a user.
 *
 * Customer rows are created lazily — signup writes a User, not a CRM record —
 * so anything that attaches a note, task or activity has to materialise the
 * shell first. Idempotent by the userId unique constraint.
 */
export async function ensureCustomer(userId: string) {
  return db.customer.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
}

// --- Metrics refresh --------------------------------------------------------

export interface RefreshResult {
  customerId: string;
  assessment: LifecycleAssessment;
  mrrCents: number;
  lifetimeValueCents: number;
  /** Set when the recomputed stage differed from what was stored. */
  stageChangedFrom: string | null;
}

/**
 * Recompute and persist the Customer caches for one user.
 *
 * Writes lifecycleStage, riskLevel, healthScore, mrrCents, lifetimeValueCents
 * and lastActivityAt. A stage change is also appended to the CRM timeline, so
 * "why does this say churned now" has an answer in the record rather than in
 * someone's memory.
 *
 * The stage written here is DERIVED. A stage set by hand through the console
 * is a correction that survives until the next refresh — durable staff
 * judgement belongs in segment, churnReason and internalNotes, which this
 * function never touches.
 */
export async function refreshCustomerMetrics(
  userId: string,
  now: Date = new Date(),
): Promise<RefreshResult | null> {
  const user = (await db.user.findUnique({
    where: { id: userId },
    select: listSelect,
  })) as ListUser | null;
  if (!user) return null;

  const aggregates = await loadAggregates([userId], now);
  const assessment = assess(user, aggregates, now);
  const mrrCents = mrrForSubscription(user.subscription);
  const lifetimeValueCents = aggregates.lifetimeValue.get(userId) ?? 0;
  const lastActivityAt = aggregates.lastActivityAt.get(userId) ?? null;

  const existing = await db.customer.findUnique({
    where: { userId },
    select: { id: true, lifecycleStage: true },
  });
  const stageChangedFrom =
    existing && existing.lifecycleStage !== assessment.stage ? existing.lifecycleStage : null;

  const data = {
    lifecycleStage: assessment.stage,
    riskLevel: assessment.risk,
    healthScore: assessment.healthScore,
    mrrCents,
    lifetimeValueCents,
    metricsRefreshedAt: now,
    ...(lastActivityAt ? { lastActivityAt } : {}),
    ...(assessment.stage === 'churned' && !existing ? { churnedAt: now } : {}),
  };

  const customer = await db.customer.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });

  // churnedAt is stamped on the transition, not on every refresh, so the date
  // keeps meaning "when they left".
  if (stageChangedFrom && assessment.stage === 'churned') {
    await db.customer.update({ where: { id: customer.id }, data: { churnedAt: now } });
  }

  if (stageChangedFrom) {
    await db.crmActivity.create({
      data: {
        customerId: customer.id,
        staffId: null,
        type: 'lifecycle',
        direction: 'internal',
        source: 'automation',
        subject: `Lifecycle stage: ${stageChangedFrom} → ${assessment.stage}`,
        body: assessment.summary,
        meta: JSON.stringify({
          from: stageChangedFrom,
          to: assessment.stage,
          risk: assessment.risk,
          reasons: assessment.reasons.map((r) => r.code),
        }),
        occurredAt: now,
      },
    });
  }

  return {
    customerId: customer.id,
    assessment,
    mrrCents,
    lifetimeValueCents,
    stageChangedFrom,
  };
}

// --- The 360° view ----------------------------------------------------------

export interface QuotaSnapshot {
  used: number;
  limit: number;
  remaining: number;
  periodStart: Date;
  periodEnd: Date;
  /** True when the window has elapsed and will reset on the customer's next call. */
  windowExpired: boolean;
  percentUsed: number;
}

export interface CustomerDetail {
  profile: {
    userId: string;
    email: string;
    fullName: string;
    phone: string | null;
    city: string | null;
    country: string;
    headline: string | null;
    linkedinUrl: string | null;
    portfolioUrl: string | null;
    workAuth: string | null;
    role: string;
    signedUpAt: Date;
    onboardedAt: Date | null;
    anonymizedAt: Date | null;
  };
  crm: {
    customerId: string | null;
    lifecycleStage: string;
    ownerStaffId: string | null;
    source: string;
    campaign: string | null;
    segment: string;
    riskLevel: string;
    healthScore: number;
    vip: boolean;
    doNotContact: boolean;
    churnedAt: Date | null;
    churnReason: string | null;
    internalNotes: string;
    lastContactedAt: Date | null;
    metricsRefreshedAt: Date | null;
  };
  assessment: LifecycleAssessment;
  subscription: {
    status: string;
    planCode: string;
    planName: string;
    interval: string;
    currency: string;
    startedAt: Date;
    renewsAt: Date;
    canceledAt: Date | null;
    cancelAtPeriodEnd: boolean;
    trialEndsAt: Date | null;
    graceEndsAt: Date | null;
    suspendedAt: Date | null;
    provider: string;
    mrrCents: number;
    bonusApplications: number;
  } | null;
  quota: QuotaSnapshot | null;
  usage: {
    agents: number;
    resumes: number;
    applicationsTotal: number;
    applicationsLast30Days: number;
    applicationsByStatus: Record<string, number>;
    interviews: number;
    savedJobs: number;
    lastActivityAt: Date | null;
  };
  billing: {
    lifetimeValueCents: number;
    outstandingCents: number;
    overdueInvoices: number;
    failedPaymentsLast30Days: number;
    invoices: {
      id: string;
      number: string | null;
      status: string;
      currency: string;
      totalCents: number;
      amountDueCents: number;
      issuedAt: Date | null;
      dueAt: Date | null;
      paidAt: Date | null;
    }[];
    payments: {
      id: string;
      provider: string;
      status: string;
      amountCents: number;
      currency: string;
      method: string;
      failureCode: string | null;
      createdAt: Date;
    }[];
    defaultPaymentMethod: {
      brand: string | null;
      last4: string | null;
      expMonth: number | null;
      expYear: number | null;
      status: string;
    } | null;
  };
  applications: {
    id: string;
    status: string;
    matchScore: number;
    company: string;
    title: string;
    appliedAt: Date | null;
    createdAt: Date;
    failureReason: string | null;
  }[];
  tickets: {
    id: string;
    number: string;
    subject: string;
    status: string;
    priority: string;
    category: string;
    breachedSla: boolean;
    assigneeStaffId: string | null;
    lastReplyAt: Date;
    createdAt: Date;
  }[];
  tasks: {
    id: string;
    title: string;
    status: string;
    priority: string;
    dueAt: Date | null;
    assigneeStaffId: string | null;
  }[];
  notes: {
    id: string;
    staffId: string;
    staffName: string;
    body: string;
    pinned: boolean;
    createdAt: Date;
  }[];
}

/**
 * Read-only quota. Deliberately not getQuota(): that function rolls the
 * billing window forward and zeroes applicationsUsed when the period has
 * elapsed, which would mean a staff member looking at an account granted it a
 * new month of applications. `windowExpired` reports the same fact without
 * causing it.
 */
export function quotaSnapshot(
  subscription: SubscriptionShape | null,
  now: Date = new Date(),
  /** Stage 15: the resolved `applications_per_month` entitlement, when the caller read it; else the plan's allowance. */
  entitledApplications?: number,
): QuotaSnapshot | null {
  if (!subscription) return null;
  const limit = entitledApplications !== undefined ? entitledApplications + subscription.bonusApplications : allowanceFor(subscription);
  const windowExpired = now > subscription.periodEnd;
  const used = windowExpired ? 0 : subscription.applicationsUsed;
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    periodStart: subscription.periodStart,
    periodEnd: subscription.periodEnd,
    windowExpired,
    percentUsed: limit > 0 ? Math.min(100, Math.floor((used * 100) / limit)) : 0,
  };
}

/**
 * Everything a support agent needs about one customer, in one call.
 *
 * `id` is the User id. Returns null when no such user exists.
 */
export async function getCustomerDetail(
  userId: string,
  now: Date = new Date(),
): Promise<CustomerDetail | null> {
  const since = new Date(now.getTime() - 30 * DAY_MS);

  const user = await db.user.findUnique({
    where: { id: userId },
    include: {
      subscription: { include: { plan: true } },
      customer: true,
    },
  });
  if (!user) return null;

  const [
    agents,
    resumes,
    savedJobs,
    interviews,
    applicationsTotal,
    applications30d,
    byStatus,
    applications,
    invoices,
    payments,
    paymentMethod,
    tickets,
    tasks,
    notes,
    lastActivity,
    invoiceTotals,
    overdueInvoices,
    failedPayments,
  ] = await Promise.all([
    db.agent.count({ where: { userId } }),
    db.resume.count({ where: { userId } }),
    db.savedJob.count({ where: { userId } }),
    db.interviewPrep.count({ where: { userId } }),
    db.application.count({ where: { userId } }),
    db.application.count({ where: { userId, createdAt: { gte: since } } }),
    db.application.groupBy({ by: ['status'], where: { userId }, _count: { _all: true } }),
    db.application.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        status: true,
        matchScore: true,
        appliedAt: true,
        createdAt: true,
        failureReason: true,
        job: { select: { company: true, title: true } },
      },
    }),
    db.invoice.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        number: true,
        status: true,
        currency: true,
        totalCents: true,
        amountDueCents: true,
        issuedAt: true,
        dueAt: true,
        paidAt: true,
      },
    }),
    db.payment.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        provider: true,
        status: true,
        amountCents: true,
        currency: true,
        method: true,
        failureCode: true,
        createdAt: true,
      },
    }),
    db.paymentMethod.findFirst({
      where: { userId, isDefault: true },
      select: { brand: true, last4: true, expMonth: true, expYear: true, status: true },
    }),
    db.supportTicket.findMany({
      where: { userId },
      orderBy: { lastReplyAt: 'desc' },
      take: 10,
      select: {
        id: true,
        number: true,
        subject: true,
        status: true,
        priority: true,
        category: true,
        breachedSla: true,
        assigneeStaffId: true,
        lastReplyAt: true,
        createdAt: true,
      },
    }),
    user.customer
      ? db.crmTask.findMany({
          where: { customerId: user.customer.id, status: { in: ['open', 'in_progress'] } },
          orderBy: [{ dueAt: 'asc' }, { createdAt: 'desc' }],
          take: 20,
          select: {
            id: true,
            title: true,
            status: true,
            priority: true,
            dueAt: true,
            assigneeStaffId: true,
          },
        })
      : Promise.resolve([]),
    user.customer
      ? db.crmNote.findMany({
          where: { customerId: user.customer.id },
          orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
          take: 20,
          select: { id: true, staffId: true, body: true, pinned: true, createdAt: true },
        })
      : Promise.resolve([]),
    db.activityEvent.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
    db.invoice.aggregate({
      where: { userId, status: { not: 'void' } },
      _sum: { amountPaidCents: true, amountRefundedCents: true, amountDueCents: true },
    }),
    db.invoice.count({ where: { userId, status: 'open', dueAt: { lt: now } } }),
    db.payment.count({ where: { userId, status: 'failed', createdAt: { gte: since } } }),
  ]);

  const subscription = user.subscription;
  // Stage 15: what the account may actually do, resolved from entitlements (read-only).
  const entitledApplications = await quantityFor(db, userId, 'applications_per_month');
  const subscriptionShape: SubscriptionShape | null = subscription
    ? {
        status: subscription.status,
        interval: subscription.interval,
        periodStart: subscription.periodStart,
        periodEnd: subscription.periodEnd,
        applicationsUsed: subscription.applicationsUsed,
        bonusApplications: subscription.bonusApplications,
        trialEndsAt: subscription.trialEndsAt,
        graceEndsAt: subscription.graceEndsAt,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        plan: subscription.plan,
      }
    : null;

  const assessment = computeLifecycle({
    now,
    signedUpAt: user.createdAt,
    subscriptionStatus: subscription?.status ?? null,
    cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
    trialEndsAt: subscription?.trialEndsAt ?? null,
    graceEndsAt: subscription?.graceEndsAt ?? null,
    periodStart: subscription?.periodStart ?? null,
    periodEnd: subscription?.periodEnd ?? null,
    applicationsUsed: subscription?.applicationsUsed ?? 0,
    applicationsLimit: entitledApplications + (subscription?.bonusApplications ?? 0),
    lastActivityAt: lastActivity?.createdAt ?? null,
    failedPaymentsLast30Days: failedPayments,
    overdueInvoices,
    applicationsLast30Days: applications30d,
  });

  const staffIds = [...new Set(notes.map((n) => n.staffId).filter(Boolean))];
  const staff = staffIds.length
    ? await db.user.findMany({
        where: { id: { in: staffIds } },
        select: { id: true, fullName: true, email: true },
      })
    : [];
  const staffNames = new Map(staff.map((s) => [s.id, s.fullName || s.email]));

  const applicationsByStatus: Record<string, number> = {};
  for (const row of byStatus) applicationsByStatus[row.status] = row._count._all;

  return {
    profile: {
      userId: user.id,
      email: user.email,
      fullName: user.fullName,
      phone: user.phone,
      city: user.city,
      country: user.country,
      headline: user.headline,
      linkedinUrl: user.linkedinUrl,
      portfolioUrl: user.portfolioUrl,
      workAuth: user.workAuth,
      role: user.role,
      signedUpAt: user.createdAt,
      onboardedAt: user.onboardedAt,
      anonymizedAt: user.anonymizedAt,
    },
    crm: {
      customerId: user.customer?.id ?? null,
      lifecycleStage: user.customer?.lifecycleStage ?? assessment.stage,
      ownerStaffId: user.customer?.ownerStaffId ?? null,
      source: user.customer?.source ?? 'organic',
      campaign: user.customer?.campaign ?? null,
      segment: user.customer?.segment ?? 'self_serve',
      riskLevel: user.customer?.riskLevel ?? assessment.risk,
      healthScore: user.customer?.healthScore ?? assessment.healthScore,
      vip: user.customer?.vip ?? false,
      doNotContact: user.customer?.doNotContact ?? false,
      churnedAt: user.customer?.churnedAt ?? null,
      churnReason: user.customer?.churnReason ?? null,
      internalNotes: user.customer?.internalNotes ?? '',
      lastContactedAt: user.customer?.lastContactedAt ?? null,
      metricsRefreshedAt: user.customer?.metricsRefreshedAt ?? null,
    },
    assessment,
    subscription: subscription
      ? {
          status: subscription.status,
          planCode: subscription.plan.code,
          planName: subscription.plan.name,
          interval: subscription.interval,
          currency: subscription.currency,
          startedAt: subscription.startedAt,
          renewsAt: subscription.renewsAt,
          canceledAt: subscription.canceledAt,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          trialEndsAt: subscription.trialEndsAt,
          graceEndsAt: subscription.graceEndsAt,
          suspendedAt: subscription.suspendedAt,
          provider: subscription.provider,
          mrrCents: mrrForSubscription(subscriptionShape),
          bonusApplications: subscription.bonusApplications,
        }
      : null,
    quota: quotaSnapshot(subscriptionShape, now, entitledApplications),
    usage: {
      agents,
      resumes,
      applicationsTotal,
      applicationsLast30Days: applications30d,
      applicationsByStatus,
      interviews,
      savedJobs,
      lastActivityAt: lastActivity?.createdAt ?? null,
    },
    billing: {
      lifetimeValueCents:
        (invoiceTotals._sum.amountPaidCents ?? 0) - (invoiceTotals._sum.amountRefundedCents ?? 0),
      outstandingCents: invoiceTotals._sum.amountDueCents ?? 0,
      overdueInvoices,
      failedPaymentsLast30Days: failedPayments,
      invoices,
      payments,
      defaultPaymentMethod: paymentMethod,
    },
    applications: applications.map((a) => ({
      id: a.id,
      status: a.status,
      matchScore: a.matchScore,
      company: a.job.company,
      title: a.job.title,
      appliedAt: a.appliedAt,
      createdAt: a.createdAt,
      failureReason: a.failureReason,
    })),
    tickets,
    tasks,
    notes: notes.map((n) => ({
      id: n.id,
      staffId: n.staffId,
      staffName: staffNames.get(n.staffId) ?? 'Unknown staff',
      body: n.body,
      pinned: n.pinned,
      createdAt: n.createdAt,
    })),
  };
}

// --- Staff-editable CRM fields ---------------------------------------------

export interface CustomerCrmPatch {
  lifecycleStage?: LifecycleStage;
  ownerStaffId?: string | null;
  segment?: string;
  source?: string;
  campaign?: string | null;
  riskLevel?: RiskLevel;
  vip?: boolean;
  doNotContact?: boolean;
  churnReason?: string | null;
  internalNotes?: string;
}

/**
 * Apply a staff edit to the CRM record.
 *
 * Creates the Customer shell if there is not one yet, writes an AuditLog row
 * naming the actor and the exact fields that moved, and drops a timeline entry
 * so the change is visible where staff already look. Returns the fields that
 * actually changed — a PATCH that changes nothing writes nothing.
 */
export async function updateCustomerCrm(
  userId: string,
  patch: CustomerCrmPatch,
  staff: StaffContext,
  reason?: string,
): Promise<{ changed: string[]; customerId: string } | null> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) return null;

  const customer = await ensureCustomer(userId);

  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const data: Record<string, unknown> = {};
  const changed: string[] = [];

  const current = customer as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (current[key] === value) continue;
    before[key] = current[key];
    after[key] = value;
    data[key] = value;
    changed.push(key);
  }

  if (changed.length === 0) return { changed: [], customerId: customer.id };

  // Stamping churnedAt here keeps "when did they leave" answerable even when a
  // human, not the refresh job, made the call.
  if (patch.lifecycleStage === 'churned' && !customer.churnedAt) {
    data.churnedAt = new Date();
  }

  await db.$transaction([
    db.customer.update({ where: { id: customer.id }, data }),
    db.crmActivity.create({
      data: {
        customerId: customer.id,
        staffId: staff.id,
        type: changed.includes('lifecycleStage') ? 'lifecycle' : 'system',
        direction: 'internal',
        source: 'console',
        subject: `Updated ${changed.join(', ')}`,
        body: reason ?? '',
        meta: JSON.stringify({ before, after }),
      },
    }),
    db.auditLog.create({
      data: {
        actorType: 'staff',
        actorId: staff.id,
        actorEmail: staff.email,
        actorRole: staff.role,
        action: 'customer.update',
        entityType: 'Customer',
        entityId: customer.id,
        summary: `${staff.email} updated ${changed.join(', ')} on customer ${userId}`,
        before: JSON.stringify(before),
        after: JSON.stringify(after),
        changedFields: JSON.stringify(changed),
        reason: reason ?? null,
      },
    }),
  ]);

  return { changed, customerId: customer.id };
}

/** Narrowing helpers for query-string parsing in the routes. */
export function parseStageFilter(value: string | null): LifecycleStage | undefined {
  return value && isLifecycleStage(value) ? value : undefined;
}

export function parseRiskFilter(value: string | null): RiskLevel | undefined {
  return value && isRiskLevel(value) ? value : undefined;
}

/** Read a JSON string column that holds a string array. */
export function parseTags(value: string | null | undefined): string[] {
  return parseJson<string[]>(value, []);
}
