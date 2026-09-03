/**
 * The tenancy classification of EVERY table in the transactional schema.
 *
 * This file is the source of truth for the row-level-security migration
 * (scripts/rls/generate-migration.ts renders it to SQL) and for the coverage
 * test (tests/tenancy-isolation.test.ts), which fails if a table exists in the
 * database that is not classified here, or is classified here and does not
 * exist. That closes the gap ADR-0005 worries about most: a new model added
 * without anyone deciding who may read it.
 *
 * Vocabulary
 * ----------
 * Policies apply to the `app_tenant` role, which request handlers assume for
 * the duration of a transaction after establishing tenant context
 * (src/lib/tenancy/context.ts). The system role — the connection's own role,
 * used for migrations, webhooks, workers and the staff console — has an
 * unconditional policy created at migration time, so nothing here restricts
 * it. That is the "narrow, audited RLS-bypassing role" of ADR-0005, made
 * explicit in the catalog rather than implied by superuser status.
 *
 * Every kind fails closed: a request that established no context, or an
 * unknown one, matches no row under any of them.
 *
 *   user        — the row carries the tenant user's id in `column`.
 *   userOrOrg   — the row belongs to a user OR to an organisation the user is
 *                 an accepted member of (invoices, API keys).
 *   org         — the row belongs to an organisation the user is a member of.
 *   orgReadOnly — as `org`, but SELECT only: the roster and the organisation
 *                 record are administered by the membership service on the
 *                 system client, so the tenant role has no reason to write
 *                 them — and a write policy there would let any member set
 *                 their own role or the organisation's AI policy.
 *   userOwnRow  — the user's own row, readable, with UPDATE confined to the
 *                 columns the tenant path actually edits (column privileges);
 *                 never `role`, `email`, `passwordHash`.
 *   viaParent   — ownership runs through a parent row; the parent's own policy
 *                 is applied inside the EXISTS, so the two can never disagree.
 *   custom      — a hand-written predicate, for the handful of tables whose
 *                 ownership is not a single column (referrals, support
 *                 messages).
 *   reference   — shared, non-personal data every tenant may READ but never
 *                 write through the tenant path (plans, jobs, tax rates).
 *   system      — never reachable from the tenant path at all. Staff CRM,
 *                 audit, gateway events, analytics rollups. A forced table
 *                 with no policy for the role denies every command.
 */

export type RlsKind =
  | { kind: 'user'; column: string }
  /** Own row(s) readable; UPDATE allowed only on the listed columns; no INSERT/DELETE. */
  | { kind: 'userOwnRow'; column: string; updatableColumns: string[] }
  /** Organisation-scoped rows readable by members; never writable on the tenant path. */
  | { kind: 'orgReadOnly'; column: string }
  | { kind: 'userOrOrg'; userColumn: string; orgColumn: string }
  | { kind: 'org'; column: string }
  | { kind: 'viaParent'; parent: string; fk: string; parentKey?: string; extra?: string }
  | { kind: 'custom'; using: string; check?: string }
  | { kind: 'reference'; where?: string }
  | { kind: 'system' };

export const RLS_TABLES: Record<string, RlsKind> = {
  // --- Identity ------------------------------------------------------------
  // A tenant reads and updates its own row only. Sign-in by email happens on
  // the system path before any tenant exists.
  User: {
    kind: 'userOwnRow',
    column: 'id',
    // Exactly what api/profile and api/resume write on the tenant path, plus
    // updatedAt because Prisma sets it on every update. `role` (the staff
    // console's second lock), `email`, `passwordHash` and the identity fields
    // are deliberately absent: they change only on the system client.
    updatableColumns: ['fullName', 'phone', 'city', 'country', 'headline', 'linkedinUrl', 'portfolioUrl', 'workAuth', 'onboardedAt', 'updatedAt'],
  },
  Session: { kind: 'user', column: 'userId' },
  UserIdentity: { kind: 'user', column: 'userId' },
  ConsentRecord: { kind: 'user', column: 'userId' },
  EmailToken: { kind: 'user', column: 'userId' },
  DeletionRequest: { kind: 'user', column: 'userId' },

  // --- Organisations ---------------------------------------------------------
  Organization: { kind: 'orgReadOnly', column: 'id' },
  // Members see the roster of the organisations they belong to. Changes to
  // the roster are made ONLY by the membership service on the system client,
  // which checks the actor's role in code; the tenant role gets no write
  // policy at all, so even a future tenant-path query cannot promote itself.
  Membership: { kind: 'orgReadOnly', column: 'organizationId' },

  // --- Candidate product data ------------------------------------------------
  Subscription: { kind: 'user', column: 'userId' },
  Resume: { kind: 'user', column: 'userId' },
  Agent: { kind: 'user', column: 'userId' },
  JobMatch: { kind: 'viaParent', parent: 'Agent', fk: 'agentId' },
  AgentSchedule: { kind: 'viaParent', parent: 'Agent', fk: 'agentId' },
  SavedJob: { kind: 'user', column: 'userId' },
  Application: { kind: 'user', column: 'userId' },
  InterviewPrep: { kind: 'user', column: 'userId' },
  ActivityEvent: { kind: 'user', column: 'userId' },
  Notification: { kind: 'user', column: 'userId' },
  NotificationPreference: { kind: 'user', column: 'userId' },
  Integration: { kind: 'user', column: 'userId' },
  ExportJob: { kind: 'user', column: 'userId' },
  // Anonymous scans (null userId) belong to nobody and stay on the system path.
  ResumeScan: { kind: 'user', column: 'userId' },
  ExperimentAssignment: { kind: 'user', column: 'userId' },
  UsageEvent: { kind: 'user', column: 'userId' },
  DailyUsageRollup: { kind: 'user', column: 'userId' },

  // --- Commercial ------------------------------------------------------------
  BillingProfile: { kind: 'user', column: 'userId' },
  Invoice: { kind: 'userOrOrg', userColumn: 'userId', orgColumn: 'organizationId' },
  InvoiceLine: { kind: 'viaParent', parent: 'Invoice', fk: 'invoiceId' },
  InvoiceTaxLine: { kind: 'viaParent', parent: 'Invoice', fk: 'invoiceId' },
  CreditNote: { kind: 'user', column: 'userId' },
  CreditNoteLine: { kind: 'viaParent', parent: 'CreditNote', fk: 'creditNoteId' },
  PaymentMethod: { kind: 'user', column: 'userId' },
  Payment: { kind: 'user', column: 'userId' },
  PaymentAttempt: { kind: 'viaParent', parent: 'Payment', fk: 'paymentId' },
  PaymentAllocation: { kind: 'viaParent', parent: 'Payment', fk: 'paymentId' },
  Refund: { kind: 'user', column: 'userId' },
  DunningState: { kind: 'user', column: 'userId' },
  DunningAttempt: { kind: 'viaParent', parent: 'Invoice', fk: 'invoiceId' },
  CreditLedgerEntry: { kind: 'user', column: 'userId' },
  CouponRedemption: { kind: 'user', column: 'userId' },
  SubscriptionEvent: { kind: 'user', column: 'userId' },
  ReferralCode: { kind: 'user', column: 'userId' },
  Referral: {
    kind: 'custom',
    using: `("referrerUserId" = app_current_user_id() OR "refereeUserId" = app_current_user_id())`,
  },

  // --- Support -----------------------------------------------------------------
  SupportTicket: { kind: 'user', column: 'userId' },
  // A customer reads the public messages on their own tickets; internal staff
  // notes never cross the boundary, whatever the application filter says.
  SupportMessage: {
    kind: 'viaParent',
    parent: 'SupportTicket',
    fk: 'ticketId',
    extra: `"internal" = false`,
  },

  // --- Public API and outbound webhooks --------------------------------------
  ApiKey: { kind: 'userOrOrg', userColumn: 'userId', orgColumn: 'organizationId' },
  ApiIdempotencyRecord: { kind: 'user', column: 'userId' },
  WebhookEndpoint: { kind: 'user', column: 'userId' },
  OutboundEvent: { kind: 'user', column: 'userId' },
  WebhookDelivery: { kind: 'viaParent', parent: 'WebhookEndpoint', fk: 'endpointId' },
  EmailLog: { kind: 'user', column: 'userId' },

  // --- Reference data (read-only through the tenant path) --------------------
  Plan: { kind: 'reference' },
  PlanPrice: { kind: 'reference', where: `"active" = true` },
  Job: { kind: 'reference' },
  TaxRate: { kind: 'reference', where: `"active" = true` },
  TaxRegistration: { kind: 'reference', where: `"active" = true` },
  FeatureFlag: { kind: 'reference' },

  // --- System only -------------------------------------------------------------
  // Coupon codes are secrets that must be resolvable only by presenting one;
  // RLS cannot express "resolve but do not enumerate", so redemption stays on
  // the system client (src/lib/billing) and the tenant path sees no coupons.
  Coupon: { kind: 'system' },
  AuditLog: { kind: 'system' },
  WebhookEvent: { kind: 'system' },
  EmailSuppression: { kind: 'system' },
  DocumentSequence: { kind: 'system' },
  DailyMetric: { kind: 'system' },
  DailyRevenueRollup: { kind: 'system' },
  RollupRun: { kind: 'system' },
  Customer: { kind: 'system' },
  CrmActivity: { kind: 'system' },
  CrmNote: { kind: 'system' },
  CrmTask: { kind: 'system' },
  ImpersonationSession: { kind: 'system' },
};

/** The role request handlers assume inside a tenant transaction. */
export const TENANT_ROLE = 'app_tenant';

/** Transaction-scoped settings that carry tenant context (ADR-0005). */
export const GUC_USER_ID = 'app.current_user_id';
export const GUC_ORGANIZATION_ID = 'app.current_organization_id';

/** Tables Prisma manages that are deliberately outside the classification. */
export const UNCLASSIFIED_TABLES = ['_prisma_migrations'];
