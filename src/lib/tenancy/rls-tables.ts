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
  /**
   * A hand-written predicate. `using` governs every command; `readUsing`,
   * when given, WIDENS SELECT only (a second, SELECT-only policy) so a party
   * who may see a row - the client their case concerns - can never update or
   * delete it (Stage 17 review, M3).
   */
  | { kind: 'custom'; using: string; check?: string; readUsing?: string }
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
  // Stage 15: a person's or an organization's entitlements; written by the service on the system client, readable on the tenant path.
  Entitlement: { kind: 'userOrOrg', userColumn: 'userId', orgColumn: 'organizationId' },
  ApiIdempotencyRecord: { kind: 'user', column: 'userId' },
  WebhookEndpoint: { kind: 'user', column: 'userId' },
  OutboundEvent: { kind: 'user', column: 'userId' },
  WebhookDelivery: { kind: 'viaParent', parent: 'WebhookEndpoint', fk: 'endpointId' },
  EmailLog: { kind: 'user', column: 'userId' },

  // --- Candidate Digital Twin (Stage 02) --------------------------------------
  // Every child row carries userId, so each is a plain user-equality policy;
  // re-parenting across users is impossible without also changing userId,
  // which WITH CHECK refuses.
  CandidateProfile: { kind: 'user', column: 'userId' },
  EmploymentHistory: { kind: 'user', column: 'userId' },
  Education: { kind: 'user', column: 'userId' },
  CandidateSkill: { kind: 'user', column: 'userId' },
  Certification: { kind: 'user', column: 'userId' },
  Project: { kind: 'user', column: 'userId' },
  Achievement: { kind: 'user', column: 'userId' },
  CandidateLanguage: { kind: 'user', column: 'userId' },
  CareerPreferences: { kind: 'user', column: 'userId' },
  WorkAuthorization: { kind: 'user', column: 'userId' },
  // Shared skill vocabulary: every tenant may read it; written on the system
  // path (Stage 04 taxonomy sync) only.
  Skill: { kind: 'reference' },

  // --- Stage 03: evidence vault, question bank, AI traceability -------------
  CareerEvidence: { kind: 'user', column: 'userId' },
  ApplicationQuestion: { kind: 'user', column: 'userId' },
  // A candidate may read the record of AI actions taken for them (own rows);
  // rows are written by the gateway on the system client. A null userId
  // (platform-level run) matches no tenant.
  // Read-only for the tenant: every AiRun is written by the gateway on the
  // system client, and a trace the subject could edit or delete is not a
  // trace. `reference` with a `where` is SELECT-only (no write policy).
  AiRun: { kind: 'reference', where: '"userId" = app_current_user_id()' },
  // Security-relevant configuration, staff-administered: never on the tenant path.
  PromptVersion: { kind: 'system' },

  // --- Reference data (read-only through the tenant path) --------------------
  Plan: { kind: 'reference' },

  // --- Stage 04: the occupational spine (ADR-0009). Shared, non-personal
  //     reference data written only by the licence-gated ingestion path.
  //     The dataset REGISTER is system-only: it carries who recorded a licence
  //     and governance notes; the attribution line a page shows is read on the
  //     system client through `loadedAttributions()` / `attributionFor()`.
  TaxonomyDataset: { kind: 'system' },
  Occupation: { kind: 'reference' },
  OccupationLabel: { kind: 'reference' },
  OccupationCode: { kind: 'reference' },
  SkillLabel: { kind: 'reference' },
  SkillMapping: { kind: 'reference' },
  OccupationSkill: { kind: 'reference' },
  CareerPath: { kind: 'reference' },
  // Stage 16: the learning and credential graph is licensed reference data (read by every tenant, written by no tenant); a plan is the person's.
  Credential: { kind: 'reference' },
  CredentialSkill: { kind: 'reference' },
  OccupationCredential: { kind: 'reference' },
  LearningProvider: { kind: 'reference' },
  LearningOffering: { kind: 'reference' },
  OfferingSkill: { kind: 'reference' },
  CareerPlan: { kind: 'user', column: 'userId' },
  CareerPlanMilestone: { kind: 'user', column: 'userId' },
  // Stage 17 (ADR-0032): case management. A case is visible to the provider
  // organisation's members AND to the client it concerns (who sees the
  // invitation and the consent state, nothing else - notes, assessments,
  // tasks, outcomes and recommendations are `org`, the provider's alone);
  // only the organisation's members may write a case on the tenant path (the
  // client consents through the service, on the system client, audited).
  // Assignment gating (a case manager sees only their own caseload) is the
  // service's, on top of this organisational isolation. The retention policy
  // is read by members and written by the service.
  RetentionPolicy: { kind: 'orgReadOnly', column: 'organizationId' },
  // The organisation's members write it; the client it concerns may READ
  // their own row (the consent state) and nothing more - a SELECT-only
  // policy, so they can neither close nor delete a case on the tenant path.
  Case: {
    kind: 'custom',
    using: '"organizationId" = ANY (app_member_organization_ids())',
    readUsing: '("organizationId" = ANY (app_member_organization_ids()) OR "clientUserId" = app_current_user_id())',
  },
  CaseNote: { kind: 'org', column: 'organizationId' },
  CaseAssessment: { kind: 'org', column: 'organizationId' },
  CaseTask: { kind: 'org', column: 'organizationId' },
  CaseOutcome: { kind: 'org', column: 'organizationId' },
  CaseFollowUp: { kind: 'org', column: 'organizationId' },
  CaseRecommendation: { kind: 'org', column: 'organizationId' },
  // Stage 18 (ADR-0033): employer-side hiring. The employer's record is the
  // organisation's; a Disclosure is visible to the organisation AND to the
  // candidate it asks about (who answers it through the service, on the
  // system client), and members alone may write it on the tenant path. No
  // candidate row is readable here: identity reaches an employer only
  // through the delegated read behind a GRANTED disclosure (employer/service.ts).
  Requisition: { kind: 'org', column: 'organizationId' },
  // The employer's members write it; the candidate it concerns may READ their
  // own row (the request and the consent state) and nothing more - a
  // SELECT-only policy (the Stage 17 review's lesson): they answer on the
  // system client, never by editing the row.
  Disclosure: {
    kind: 'custom',
    using: '"organizationId" = ANY (app_member_organization_ids())',
    readUsing: '("organizationId" = ANY (app_member_organization_ids()) OR "candidateUserId" = app_current_user_id())',
  },
  TalentPool: { kind: 'org', column: 'organizationId' },
  TalentPoolMember: { kind: 'org', column: 'organizationId' },
  Submission: { kind: 'org', column: 'organizationId' },
  SubmissionEvent: { kind: 'org', column: 'organizationId' },
  EmployerInterview: { kind: 'org', column: 'organizationId' },
  EmployerNote: { kind: 'org', column: 'organizationId' },
  Offer: { kind: 'org', column: 'organizationId' },
  Region: { kind: 'reference' },
  RegionLabel: { kind: 'reference' },

  // --- Stage 05: the connector framework (ADR-0008). The source register and
  //     run audit are admin surfaces (legal basis, credential names, errors):
  //     system-only. Snapshots are the posting as captured, shared like Job.
  //     The ATS ruleset registry is read by the v1 API on the system client.
  JobSource: { kind: 'system' },
  JobSourceRun: { kind: 'system' },
  JobSnapshot: { kind: 'reference' },
  // Stage 06: which sources carry a canonical job — shared like Job.
  JobProvenance: { kind: 'reference' },
  // Stage 07: the candidate's own eligibility verdicts.
  EligibilityResult: { kind: 'user', column: 'userId' },
  // Stage 08: the candidate's own per-dimension match rows; the weight
  // register is administered in the console and never read by a tenant.
  MatchDimension: { kind: 'user', column: 'userId' },
  MatchWeightVersion: { kind: 'system' },
  FieldMappingVersion: { kind: 'system' },
  CandidateOutcomeMart: { kind: 'user', column: 'userId' },
  CandidateMatchMart: { kind: 'user', column: 'userId' },
  CandidateBenchmarkMart: { kind: 'system' },
  // Stage 09: the candidate's own document versions (bytes in the object store).
  DocumentVersion: { kind: 'user', column: 'userId' },
  // Stage 10: the canonical application record's children, all the applicant's own.
  ApplicationStatusHistory: { kind: 'user', column: 'userId' },
  ApplicationContact: { kind: 'user', column: 'userId' },
  ApplicationInterview: { kind: 'user', column: 'userId' },
  ApplicationAssessment: { kind: 'user', column: 'userId' },
  ApplicationFollowUp: { kind: 'user', column: 'userId' },
  ApplicationNote: { kind: 'user', column: 'userId' },
  // Stage 11: mailbox and calendar REFERENCES are the applicant's own; the
  // encrypted token set is system-only — no tenant policy, by design.
  MailboxConnection: { kind: 'user', column: 'userId' },
  MailboxSecret: { kind: 'system' },
  EmailThread: { kind: 'user', column: 'userId' },
  EmailMessageRef: { kind: 'user', column: 'userId' },
  CalendarEventRef: { kind: 'user', column: 'userId' },
  IntegrationEvent: { kind: 'user', column: 'userId' },
  AtsRuleset: { kind: 'system' },
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

/**
 * Which RLS migration owns each table's policies. The generator renders one
 * migration per manifest (scripts/rls/generate-migration.ts --manifest <dir>),
 * and the determinism test regenerates every manifest and compares. A table
 * whose classification changes after its migration has shipped is re-listed
 * in a NEW manifest: the generated DDL is idempotent (DROP POLICY IF EXISTS),
 * so re-emitting a table's policies later is the supported way to change them.
 */
export interface RlsManifest {
  /** Directory name under prisma/migrations. */
  migration: string;
  /** Emit the role, grants and accessor functions. Once, in the first manifest. */
  preamble: boolean;
  /** Tables whose policies this migration (re)creates. */
  tables: string[];
}

export const STAGE_01_TABLES = [
  'ActivityEvent', 'Agent', 'AgentSchedule', 'ApiIdempotencyRecord', 'ApiKey', 'Application', 'AuditLog',
  'BillingProfile', 'ConsentRecord', 'Coupon', 'CouponRedemption', 'CreditLedgerEntry', 'CreditNote',
  'CreditNoteLine', 'CrmActivity', 'CrmNote', 'CrmTask', 'Customer', 'DailyMetric', 'DailyRevenueRollup',
  'DailyUsageRollup', 'DeletionRequest', 'DocumentSequence', 'DunningAttempt', 'DunningState', 'EmailLog',
  'EmailSuppression', 'EmailToken', 'ExperimentAssignment', 'ExportJob', 'FeatureFlag', 'ImpersonationSession',
  'Integration', 'InterviewPrep', 'Invoice', 'InvoiceLine', 'InvoiceTaxLine', 'Job', 'JobMatch', 'Membership',
  'Notification', 'NotificationPreference', 'Organization', 'OutboundEvent', 'Payment', 'PaymentAllocation',
  'PaymentAttempt', 'PaymentMethod', 'Plan', 'PlanPrice', 'Referral', 'ReferralCode', 'Refund', 'Resume',
  'ResumeScan', 'RollupRun', 'SavedJob', 'Session', 'Subscription', 'SubscriptionEvent', 'SupportMessage',
  'SupportTicket', 'TaxRate', 'TaxRegistration', 'UsageEvent', 'User', 'UserIdentity', 'WebhookDelivery',
  'WebhookEndpoint', 'WebhookEvent',
];

export const STAGE_02_TABLES = [
  'Achievement', 'CandidateLanguage', 'CandidateProfile', 'CandidateSkill', 'CareerPreferences', 'Certification',
  'Education', 'EmploymentHistory', 'Project', 'Skill', 'WorkAuthorization',
];

export const STAGE_03_TABLES = ['AiRun', 'ApplicationQuestion', 'CareerEvidence', 'PromptVersion'];

export const STAGE_04_TABLES = [
  'CareerPath', 'Occupation', 'OccupationCode', 'OccupationLabel', 'OccupationSkill', 'Region', 'RegionLabel',
  'SkillLabel', 'SkillMapping', 'TaxonomyDataset',
];

export const STAGE_05_TABLES = ['AtsRuleset', 'JobSnapshot', 'JobSource', 'JobSourceRun'];
export const STAGE_06_TABLES = ['JobProvenance'];
export const STAGE_07_TABLES = ['EligibilityResult'];
export const STAGE_08_TABLES = ['MatchDimension', 'MatchWeightVersion'];
export const STAGE_09_TABLES = ['DocumentVersion'];
export const STAGE_10_TABLES = ['ApplicationStatusHistory', 'ApplicationContact', 'ApplicationInterview', 'ApplicationAssessment', 'ApplicationFollowUp', 'ApplicationNote'];
export const STAGE_11_TABLES = ['MailboxConnection', 'MailboxSecret', 'EmailThread', 'EmailMessageRef', 'CalendarEventRef', 'IntegrationEvent'];
export const STAGE_12_TABLES = ['FieldMappingVersion'];
export const STAGE_13_TABLES = ['CandidateOutcomeMart', 'CandidateMatchMart', 'CandidateBenchmarkMart'];
export const STAGE_15_TABLES = ['Entitlement'];
export const STAGE_16_TABLES = ['Credential', 'CredentialSkill', 'OccupationCredential', 'LearningProvider', 'LearningOffering', 'OfferingSkill', 'CareerPlan', 'CareerPlanMilestone'];
export const STAGE_17_TABLES = ['RetentionPolicy', 'Case', 'CaseNote', 'CaseAssessment', 'CaseTask', 'CaseOutcome', 'CaseFollowUp', 'CaseRecommendation'];
export const STAGE_18_TABLES = ['Requisition', 'Disclosure', 'TalentPool', 'TalentPoolMember', 'Submission', 'SubmissionEvent', 'EmployerInterview', 'EmployerNote', 'Offer'];

export const RLS_MANIFESTS: RlsManifest[] = [
  { migration: '20260903073000_row_level_security', preamble: true, tables: STAGE_01_TABLES },
  { migration: '20260903081400_rls_candidate_tables', preamble: false, tables: STAGE_02_TABLES },
  { migration: '20260903090100_rls_evidence_tables', preamble: false, tables: STAGE_03_TABLES },
  { migration: '20260903100100_rls_taxonomy_tables', preamble: false, tables: STAGE_04_TABLES },
  { migration: '20260903110100_rls_connector_tables', preamble: false, tables: STAGE_05_TABLES },
  { migration: '20260903130100_rls_provenance_table', preamble: false, tables: STAGE_06_TABLES },
  { migration: '20260903150100_rls_eligibility_table', preamble: false, tables: STAGE_07_TABLES },
  { migration: '20260903160100_rls_matching_tables', preamble: false, tables: STAGE_08_TABLES },
  { migration: '20260903170100_rls_document_table', preamble: false, tables: STAGE_09_TABLES },
  { migration: '20260903180100_rls_crm_tables', preamble: false, tables: STAGE_10_TABLES },
  { migration: '20260903190100_rls_mailbox_tables', preamble: false, tables: STAGE_11_TABLES },
  { migration: '20260903200100_rls_field_mapping_table', preamble: false, tables: STAGE_12_TABLES },
  { migration: '20260903210100_rls_candidate_marts', preamble: false, tables: STAGE_13_TABLES },
  { migration: '20260905120100_rls_entitlements', preamble: false, tables: STAGE_15_TABLES },
  { migration: '20260905140100_rls_career_graph', preamble: false, tables: STAGE_16_TABLES },
  { migration: '20260905160100_rls_case_management', preamble: false, tables: STAGE_17_TABLES },
  { migration: '20260905180100_rls_talent_acquisition', preamble: false, tables: STAGE_18_TABLES },
];
