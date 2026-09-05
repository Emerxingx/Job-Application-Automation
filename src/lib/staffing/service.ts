/**
 * Stage 19 (ADR-0034) - staffing and placement for an AGENCY organisation:
 * client contracts, fee structures, engagements, the candidate's
 * representation consent, placements, and the invoices the agency raises
 * to its CLIENT.
 *
 * Two rules the whole module bends around. First, employer-paid placement
 * and candidate-paid subscriptions never share a billing path: nothing
 * here imports the subscription, entitlement or invoice modules, a fee
 * structure whose payer is not the client is refused, and a
 * `PlacementInvoice` has no user id (a static test and a database test
 * hold this). Second, jurisdictional rules are DATA: the pure engine in
 * jurisdiction.ts evaluates the rows counsel recorded, an unknown is not a
 * pass, and no invoice is issued under a jurisdiction whose rules are not
 * recorded (L-4). Representation follows the Stage 17/18 consent pattern:
 * addressed to an email, granted by the candidate in one transaction with
 * their `ConsentRecord` (`agency_representation`, wording pending L-5),
 * revocable, and SELECT-only for them under RLS.
 */
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { CONSENT_VERSIONS, grantConsent } from '@/lib/consent';
import { LIMITS, rateLimit } from '@/lib/rate-limit';
import { allocateDocumentNumber, prismaSequenceStore } from '@/lib/billing/numbering';
import { hashEmail, recordSecurityEvent, type RequestMeta, type SecurityEvent } from '@/lib/security-audit';
import { findActiveMembership } from '@/lib/tenancy/organizations';
import { readStaffingInvoices, readStaffingProductivity } from '@/lib/analytics/organization/read';
import type { StaffContext } from '@/lib/crm/auth';
import { canCreateEngagement, canInvoice, canReadContract, canReadEngagement, canReadFee, canReadInvoice, canReadProductivity, canReadRepresentation, canRequestRepresentation, canWriteContract, canWriteEngagement, canWriteFee, canWritePlacement, isStaffingRole, staffingRoleOf, type StaffingRole, type StaffingServiceRole } from './roles';
import { JURISDICTION_ENGINE_VERSION, SEEDED_JURISDICTIONS, computeFee, evaluateJurisdiction, isJurisdictionCode, type JurisdictionRuleRow } from './jurisdiction';

type Client = Prisma.TransactionClient | typeof db;

export class StaffingError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'StaffingError';
    this.status = status;
  }
}

export interface StaffingActor {
  user: { id: string; email: string };
  organizationId: string;
  role: StaffingRole;
  meta?: RequestMeta;
}

export const CONTRACT_STATUSES = ['draft', 'active', 'ended'] as const;
export const FEE_KINDS = ['contingency', 'retained', 'flat'] as const;
export const ENGAGEMENT_STATUSES = ['draft', 'active', 'filled', 'closed'] as const;
/** `cancelled` is a placement the candidate never started (from `pending`); `fell_off` is a departure AFTER starting - the only status the guarantee clock reads. */
export const PLACEMENT_STATUSES = ['pending', 'started', 'completed', 'fell_off', 'cancelled'] as const;
export const FELL_OFF_REASONS = ['candidate_resigned', 'client_terminated', 'other'] as const;
export const INVOICE_VOID_REASONS = ['duplicate', 'placement_cancelled', 'other'] as const;

export async function requireStaffingActor(user: { id: string; email: string }, organizationId: string, meta?: RequestMeta): Promise<StaffingActor> {
  const membership = await findActiveMembership(db, organizationId, user.id);
  if (!membership) throw new StaffingError('Organization not found.', 404);
  const org = await db.organization.findUnique({ where: { id: organizationId }, select: { type: true } });
  if (!org || org.type !== 'staffing_agency') throw new StaffingError('Organization not found.', 404);
  return { user, organizationId, role: staffingRoleOf(membership), meta };
}

export async function agencyMemberships(userId: string) {
  const rows = await db.membership.findMany({ where: { userId, acceptedAt: { not: null }, removedAt: null, organization: { type: 'staffing_agency' } }, include: { organization: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } });
  return rows.map((m) => ({ organizationId: m.organization.id, name: m.organization.name, role: staffingRoleOf(m) }));
}

async function audit(event: SecurityEvent, actor: StaffingActor, entityType: string, entityId: string, summary: string, detail: Record<string, string | number | boolean | null> = {}): Promise<void> {
  await recordSecurityEvent(
    { event, actor: { type: 'user', id: actor.user.id, email: actor.user.email, role: `staffing:${actor.role}` }, entityType, entityId, summary, detail: { organizationId: actor.organizationId, ...detail }, meta: actor.meta },
    db,
    { strict: true },
  );
}

export async function setStaffingRole(actor: StaffingActor, memberUserId: string, serviceRole: StaffingServiceRole | null): Promise<void> {
  if (actor.role !== 'admin') throw new StaffingError('Only an administrator sets roles.', 403);
  if (serviceRole !== null && !isStaffingRole(serviceRole)) throw new StaffingError('Unknown role.', 422);
  const m = await findActiveMembership(db, actor.organizationId, memberUserId);
  if (!m) throw new StaffingError('No such member.', 404);
  await db.membership.update({ where: { id: m.id }, data: { serviceRole } });
  await audit('staffing.role.set', actor, 'Membership', m.id, `Staffing role set: ${serviceRole ?? 'none'}`, { memberUserId, from: m.serviceRole, to: serviceRole });
}

// --- Jurisdiction rules (staff-recorded reference data) ----------------------

/** Every targeted jurisdiction has a row; a new one is `unrecorded` with every rule value null. Idempotent; never touches a recorded row. */
export async function ensureJurisdictionRegistry(client: Client = db) {
  for (const j of SEEDED_JURISDICTIONS) {
    await client.staffingJurisdictionRule.upsert({ where: { jurisdiction: j.jurisdiction }, create: { jurisdiction: j.jurisdiction, name: j.name }, update: {} });
  }
  return client.staffingJurisdictionRule.findMany({ orderBy: { jurisdiction: 'asc' } });
}

/** The registry as a READ: every seeded jurisdiction, from its row where one exists and as an unrecorded placeholder where none does yet. Writes nothing (Stage 19 review, L16). */
export async function listJurisdictionRegistry(client: Client = db) {
  const rows = await client.staffingJurisdictionRule.findMany({ orderBy: { jurisdiction: 'asc' } });
  const missing = SEEDED_JURISDICTIONS.filter((j) => !rows.some((r) => r.jurisdiction === j.jurisdiction)).map((j) => ({ id: '', jurisdiction: j.jurisdiction, name: j.name, status: 'unrecorded', licenceRequired: null, candidateFeesProhibited: null, maxGuaranteeDays: null, reference: '', notes: '', recordedByEmail: '', recordedAt: null, createdAt: null, updatedAt: null }));
  return [...rows, ...missing].sort((a, b) => a.jurisdiction.localeCompare(b.jurisdiction));
}

export interface JurisdictionRuleInput {
  status: 'recorded' | 'prohibited' | 'unrecorded';
  licenceRequired: boolean | null;
  candidateFeesProhibited: boolean | null;
  maxGuaranteeDays: number | null;
  reference: string;
  notes?: string;
}

/** Counsel's answer for one jurisdiction, recorded by an admin with a citation and audited (L-4). */
export async function recordJurisdictionRule(staff: StaffContext, jurisdiction: string, input: JurisdictionRuleInput, reason: string, meta?: RequestMeta) {
  if (!isJurisdictionCode(jurisdiction)) throw new StaffingError('A jurisdiction is COUNTRY or COUNTRY-REGION, upper-case.', 422);
  const existing = await db.staffingJurisdictionRule.findUnique({ where: { jurisdiction } });
  // Counsel is asked about the jurisdictions the product TARGETS: a code
  // outside the seeded list (and not already a row) is added to the list in
  // code first, with the product decision behind it - not typed into a form.
  if (!existing && !SEEDED_JURISDICTIONS.some((j) => j.jurisdiction === jurisdiction)) throw new StaffingError(`${jurisdiction} is not a jurisdiction this product targets; add it to the seeded list before recording a rule for it.`, 422);
  if (input.status === 'recorded' && !input.reference.trim()) throw new StaffingError('A recorded rule cites the statute or regulation counsel relied on.', 422);
  if (input.maxGuaranteeDays !== null && (!Number.isInteger(input.maxGuaranteeDays) || input.maxGuaranteeDays < 0 || input.maxGuaranteeDays > 3650)) throw new StaffingError('maxGuaranteeDays is a whole number of days between 0 (no guarantee may be offered) and 3650, or empty.', 422);
  if (!reason.trim()) throw new StaffingError('A reason is required.', 422);
  const name = existing?.name ?? SEEDED_JURISDICTIONS.find((j) => j.jurisdiction === jurisdiction)?.name ?? jurisdiction;
  const row = await db.staffingJurisdictionRule.upsert({
    where: { jurisdiction },
    create: { jurisdiction, name, status: input.status, licenceRequired: input.licenceRequired, candidateFeesProhibited: input.candidateFeesProhibited, maxGuaranteeDays: input.maxGuaranteeDays, reference: input.reference.trim(), notes: input.notes?.trim() ?? '', recordedByEmail: staff.email, recordedAt: new Date() },
    update: { status: input.status, licenceRequired: input.licenceRequired, candidateFeesProhibited: input.candidateFeesProhibited, maxGuaranteeDays: input.maxGuaranteeDays, reference: input.reference.trim(), notes: input.notes?.trim() ?? '', recordedByEmail: staff.email, recordedAt: new Date() },
  });
  await recordSecurityEvent(
    { event: 'staffing.jurisdiction.recorded', actor: { type: 'staff', id: staff.id, email: staff.email, role: staff.role }, entityType: 'StaffingJurisdictionRule', entityId: row.id, summary: `Jurisdiction rule recorded: ${jurisdiction} (${input.status})`, detail: { jurisdiction, status: input.status, licenceRequired: input.licenceRequired, candidateFeesProhibited: input.candidateFeesProhibited, maxGuaranteeDays: input.maxGuaranteeDays, reason: reason.trim().slice(0, 500) }, meta },
    db,
    { strict: true },
  );
  return row;
}

async function rulesFor(client: Client): Promise<JurisdictionRuleRow[]> {
  return client.staffingJurisdictionRule.findMany({ select: { jurisdiction: true, name: true, status: true, licenceRequired: true, candidateFeesProhibited: true, maxGuaranteeDays: true } });
}

// --- Contracts and fee structures -----------------------------------------------

export interface ContractInput {
  clientName: string;
  clientContactEmail?: string;
  jurisdiction: string;
  terms?: string;
  agencyLicenceRef?: string;
  startsAt?: Date | null;
  endsAt?: Date | null;
}

export async function createContract(tx: Client, actor: StaffingActor, input: ContractInput) {
  if (!canWriteContract(actor.role)) throw new StaffingError('Only an administrator writes client contracts.', 403);
  if (!isJurisdictionCode(input.jurisdiction)) throw new StaffingError('A jurisdiction is COUNTRY or COUNTRY-REGION, upper-case (CA-BC, US-NY).', 422);
  return tx.clientContract.create({ data: { organizationId: actor.organizationId, clientName: input.clientName.trim(), clientContactEmail: input.clientContactEmail?.trim().toLowerCase() ?? '', jurisdiction: input.jurisdiction, terms: input.terms?.trim() ?? '', agencyLicenceRef: input.agencyLicenceRef?.trim() ?? '', startsAt: input.startsAt ?? null, endsAt: input.endsAt ?? null, createdById: actor.user.id } });
}

async function ownedContract(tx: Client, actor: StaffingActor, id: string) {
  const c = await tx.clientContract.findFirst({ where: { id, organizationId: actor.organizationId } });
  if (!c) throw new StaffingError('Contract not found.', 404);
  return c;
}

export async function setContractStatus(tx: Client, actor: StaffingActor, id: string, status: (typeof CONTRACT_STATUSES)[number]) {
  if (!canWriteContract(actor.role)) throw new StaffingError('Only an administrator writes client contracts.', 403);
  const c = await ownedContract(tx, actor, id);
  const allowed: Record<string, string[]> = { draft: ['active'], active: ['ended'], ended: [] };
  if (!allowed[c.status]?.includes(status)) throw new StaffingError(`A ${c.status} contract cannot become ${status}.`, 409);
  return tx.clientContract.update({ where: { id: c.id }, data: { status, ...(status === 'active' && !c.startsAt ? { startsAt: new Date() } : {}), ...(status === 'ended' ? { endsAt: new Date() } : {}) } });
}

export async function listContracts(tx: Client, actor: StaffingActor) {
  if (!canReadContract(actor.role)) throw new StaffingError('You may not read contracts.', 403);
  return tx.clientContract.findMany({ where: { organizationId: actor.organizationId }, orderBy: [{ status: 'asc' }, { clientName: 'asc' }], include: { _count: { select: { engagements: true } } } });
}

export interface FeeInput {
  name: string;
  kind: (typeof FEE_KINDS)[number];
  percentBps?: number | null;
  flatCents?: number | null;
  currency?: 'CAD' | 'USD';
  guaranteeDays?: number;
  contractId?: string | null;
  /** Accepted only as `client`; present in the input so a caller who tries anything else is refused explicitly. */
  paidBy?: string;
}

/** A fee structure describes what the CLIENT pays. Anything else is refused here, before any row exists. */
export async function createFeeStructure(tx: Client, actor: StaffingActor, input: FeeInput) {
  if (!canWriteFee(actor.role)) throw new StaffingError('Only an administrator writes fee structures.', 403);
  if ((input.paidBy ?? 'client') !== 'client') throw new StaffingError('A fee is paid by the client. No candidate is charged on an employer-paid engagement.', 422);
  if (!(FEE_KINDS as readonly string[]).includes(input.kind)) throw new StaffingError('Unknown fee kind.', 422);
  if (input.kind === 'flat') {
    if (!Number.isInteger(input.flatCents) || (input.flatCents as number) <= 0) throw new StaffingError('A flat fee is a positive amount in cents.', 422);
  } else if (!Number.isInteger(input.percentBps) || (input.percentBps as number) <= 0 || (input.percentBps as number) > 10_000) {
    throw new StaffingError('A percentage fee is between 1 and 10000 basis points.', 422);
  }
  const guaranteeDays = input.guaranteeDays ?? 90;
  if (!Number.isInteger(guaranteeDays) || guaranteeDays < 0 || guaranteeDays > 3650) throw new StaffingError('The guarantee period is a whole number of days between 0 and 3650.', 422);
  if (input.contractId) await ownedContract(tx, actor, input.contractId);
  return tx.feeStructure.create({ data: { organizationId: actor.organizationId, contractId: input.contractId ?? null, name: input.name.trim(), kind: input.kind, percentBps: input.kind === 'flat' ? null : (input.percentBps as number), flatCents: input.kind === 'flat' ? (input.flatCents as number) : null, currency: input.currency ?? 'CAD', guaranteeDays, paidBy: 'client', createdById: actor.user.id } });
}

export async function listFeeStructures(tx: Client, actor: StaffingActor) {
  if (!canReadFee(actor.role)) throw new StaffingError('You may not read fee structures.', 403);
  return tx.feeStructure.findMany({ where: { organizationId: actor.organizationId }, orderBy: { name: 'asc' } });
}

// --- Engagements ------------------------------------------------------------------

async function ownedEngagement(tx: Client, actor: StaffingActor, id: string) {
  if (!canReadEngagement(actor.role)) throw new StaffingError('Engagement not found.', 404);
  const e = await tx.engagement.findFirst({ where: { id, organizationId: actor.organizationId } });
  if (!e) throw new StaffingError('Engagement not found.', 404);
  return e;
}

export async function createEngagement(tx: Client, actor: StaffingActor, input: { contractId: string; feeStructureId: string; title: string; description?: string; ownerRecruiterId?: string | null }) {
  if (!canCreateEngagement(actor.role)) throw new StaffingError('Only an administrator, delivery or a recruiter opens an engagement.', 403);
  const contract = await ownedContract(tx, actor, input.contractId);
  const fee = await tx.feeStructure.findFirst({ where: { id: input.feeStructureId, organizationId: actor.organizationId } });
  if (!fee) throw new StaffingError('Fee structure not found.', 404);
  if (fee.contractId && fee.contractId !== contract.id) throw new StaffingError('That fee structure belongs to another contract.', 422);
  const owner = actor.role === 'recruiter' ? actor.user.id : (input.ownerRecruiterId ?? null);
  if (owner) {
    const m = await findActiveMembership(tx, actor.organizationId, owner);
    if (!m || (staffingRoleOf(m) !== 'recruiter' && staffingRoleOf(m) !== 'admin')) throw new StaffingError('The owner is a recruiter of this organisation.', 422);
  }
  return tx.engagement.create({ data: { organizationId: actor.organizationId, contractId: contract.id, feeStructureId: fee.id, title: input.title.trim(), description: input.description?.trim() ?? '', jurisdiction: contract.jurisdiction, ownerRecruiterId: owner, createdById: actor.user.id } });
}

export async function setEngagementStatus(tx: Client, actor: StaffingActor, id: string, status: (typeof ENGAGEMENT_STATUSES)[number]) {
  const e = await ownedEngagement(tx, actor, id);
  if (!canWriteEngagement(actor.role, e, actor.user.id)) throw new StaffingError('You may not change this engagement.', 403);
  const allowed: Record<string, string[]> = { draft: ['active', 'closed'], active: ['filled', 'closed'], filled: ['closed'], closed: [] };
  if (!allowed[e.status]?.includes(status)) throw new StaffingError(`A ${e.status} engagement cannot become ${status}.`, 409);
  if (status === 'active') {
    const contract = await ownedContract(tx, actor, e.contractId);
    if (contract.status !== 'active') throw new StaffingError('The client contract is not active.', 409);
  }
  return tx.engagement.update({ where: { id: e.id }, data: { status, openedAt: status === 'active' ? (e.openedAt ?? new Date()) : e.openedAt, closedAt: status === 'closed' ? new Date() : null } });
}

export async function listEngagements(tx: Client, actor: StaffingActor) {
  if (!canReadEngagement(actor.role)) throw new StaffingError('You may not read engagements.', 403);
  return tx.engagement.findMany({ where: { organizationId: actor.organizationId }, orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }], include: { contract: { select: { clientName: true, jurisdiction: true, status: true } }, _count: { select: { representations: true, placements: true } } } });
}

export async function loadEngagement(tx: Client, actor: StaffingActor, id: string) {
  const e = await ownedEngagement(tx, actor, id);
  const [contract, fee, representations, placements, rules] = await Promise.all([
    ownedContract(tx, actor, e.contractId),
    tx.feeStructure.findFirst({ where: { id: e.feeStructureId } }),
    canReadRepresentation(actor.role) ? tx.representationConsent.findMany({ where: { engagementId: e.id }, orderBy: { requestedAt: 'desc' } }) : [],
    tx.placement.findMany({ where: { engagementId: e.id }, orderBy: { createdAt: 'desc' }, include: { invoices: { select: { id: true, number: true, status: true, amountCents: true, creditedCents: true } } } }),
    rulesFor(tx),
  ]);
  // The evaluation always reads the fee row (who pays, the guarantee length)
  // so every role sees the same verdict; the row itself reaches only the
  // roles that read fees (Stage 19 review, M12).
  const jurisdiction = evaluateJurisdiction(rules, { jurisdiction: e.jurisdiction, paidBy: fee?.paidBy ?? 'client', guaranteeDays: fee?.guaranteeDays ?? 0, agencyLicenceStated: contract.agencyLicenceRef !== '' });
  return {
    engagement: e,
    contract: { id: contract.id, clientName: contract.clientName, jurisdiction: contract.jurisdiction, status: contract.status, agencyLicenceRef: contract.agencyLicenceRef },
    fee: canReadFee(actor.role) ? fee : null,
    jurisdiction,
    representations: representations.map((r) => ({ id: r.id, status: r.status, email: r.invitedEmail, name: r.status === 'granted' ? r.invitedName : null, candidateUserId: r.status === 'granted' ? r.candidateUserId : null, requestedAt: r.requestedAt, respondedAt: r.respondedAt })),
    placements: placements.map((p) => ({ ...p, feeCents: canReadFee(actor.role) ? p.feeCents : null, salaryCents: canReadFee(actor.role) ? p.salaryCents : null, invoices: canReadInvoice(actor.role) ? p.invoices : [] })),
    canWrite: canWriteEngagement(actor.role, e, actor.user.id),
    canRequest: canRequestRepresentation(actor.role, e, actor.user.id),
    canInvoice: canInvoice(actor.role),
  };
}

// --- Representation consent ---------------------------------------------------------

/**
 * Ask a person, by the email they gave the recruiter, to be represented for
 * this engagement. The accounts table is never consulted (the Stage 17
 * rule): the answer is the same with or without an account, the audit row
 * carries a digest, and the person sees the request under Settings when
 * their account address matches. A person who declined is not asked again
 * for that engagement.
 */
export async function requestRepresentation(actor: StaffingActor, input: { engagementId: string; email: string; message?: string }) {
  const e = await db.engagement.findFirst({ where: { id: input.engagementId, organizationId: actor.organizationId } });
  if (!e || !canReadEngagement(actor.role)) throw new StaffingError('Engagement not found.', 404);
  if (!canRequestRepresentation(actor.role, e, actor.user.id)) throw new StaffingError('Only the engagement\'s recruiter or an administrator asks for representation.', 403);
  if (e.status !== 'active' && e.status !== 'draft') throw new StaffingError('This engagement is not open.', 409);
  // A request is a row a person sees under Settings: volume is bounded per
  // recruiter and per agency so an address list cannot be sprayed (Stage 19
  // review, H1; the Stage 17 limits, reused).
  if (!(await rateLimit('staffing:represent', actor.user.id, LIMITS.representationRequest)).ok) throw new StaffingError('Too many representation requests from this account; try again later.', 429);
  if (!(await rateLimit('staffing:represent:org', actor.organizationId, LIMITS.representationRequestOrganization)).ok) throw new StaffingError('This agency has reached its representation-request limit for today.', 429);
  const email = input.email.trim().toLowerCase();
  const existing = await db.representationConsent.findUnique({ where: { engagementId_invitedEmail: { engagementId: e.id, invitedEmail: email } } });
  if (existing && (existing.status === 'requested' || existing.status === 'granted')) throw new StaffingError('A request for that address already exists on this engagement.', 409);
  if (existing && existing.status === 'declined') throw new StaffingError('That person declined representation for this engagement; the platform does not ask again.', 409);
  // A withdrawn consent is final for the engagement too: the row may be cited
  // by a placement and is never reset (Stage 19 review, M5), and a person who
  // took consent back is not asked for it again by the same engagement.
  if (existing && existing.status === 'revoked') throw new StaffingError('That person withdrew representation for this engagement; the platform does not ask again.', 409);
  if (existing) throw new StaffingError('A request for that address already exists on this engagement.', 409);
  const message = (input.message ?? '').trim().slice(0, 500);
  const r = await db.representationConsent.create({ data: { organizationId: actor.organizationId, engagementId: e.id, invitedEmail: email, message, requestedById: actor.user.id } });
  await audit('representation.requested', actor, 'RepresentationConsent', r.id, 'Representation requested', { engagementId: e.id, emailDigest: hashEmail(email) });
  return r;
}

/** The candidate's side: linked rows on their tenant path, invitations addressed to their account email on the system client (as with cases). */
export async function listCandidateRepresentations(tx: Client, candidate: { id: string; email: string }) {
  const [linked, invited] = await Promise.all([
    tx.representationConsent.findMany({ where: { candidateUserId: candidate.id } }),
    db.representationConsent.findMany({ where: { candidateUserId: null, status: 'requested', invitedEmail: candidate.email.trim().toLowerCase() } }),
  ]);
  const rows = [...invited, ...linked].sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime());
  const orgIds = [...new Set(rows.map((r) => r.organizationId))];
  const engIds = [...new Set(rows.map((r) => r.engagementId))];
  const [orgs, engagements] = await Promise.all([
    orgIds.length ? db.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } }) : [],
    engIds.length ? db.engagement.findMany({ where: { id: { in: engIds } }, select: { id: true, title: true, jurisdiction: true, contract: { select: { clientName: true } } } }) : [],
  ]);
  return rows.map((r) => {
    const e = engagements.find((x) => x.id === r.engagementId);
    return { ...r, organization: { name: orgs.find((o) => o.id === r.organizationId)?.name ?? 'A staffing agency' }, engagement: { title: e?.title ?? '', clientName: e?.contract.clientName ?? '', jurisdiction: e?.jurisdiction ?? '' } };
  });
}

/** Granting links the person, snapshots their name and writes the consent record in ONE transaction; declining is final for that engagement and records nothing about them. */
export async function respondToRepresentation(candidate: { id: string; email: string }, id: string, grant: boolean, meta?: RequestMeta) {
  const email = candidate.email.trim().toLowerCase();
  const r = await db.representationConsent.findFirst({ where: { id, OR: [{ candidateUserId: candidate.id }, { candidateUserId: null, invitedEmail: email }] } });
  if (!r) throw new StaffingError('Request not found.', 404);
  if (r.status !== 'requested' || r.candidateUserId !== null) throw new StaffingError('This request has already been answered.', 409);
  if (!grant) {
    const declined = await db.representationConsent.update({ where: { id: r.id }, data: { status: 'declined', respondedAt: new Date() } });
    await recordSecurityEvent({ event: 'representation.declined', user: candidate, entityType: 'RepresentationConsent', entityId: r.id, summary: 'Candidate declined representation', detail: { organizationId: r.organizationId, engagementId: r.engagementId }, meta }, db, { strict: true });
    return declined;
  }
  const granted = await db.$transaction(async (tx) => {
    const person = await tx.user.findUniqueOrThrow({ where: { id: candidate.id }, select: { fullName: true } });
    const consent = await grantConsent(tx, candidate, 'agency_representation', { source: 'settings', meta });
    return tx.representationConsent.update({ where: { id: r.id }, data: { status: 'granted', candidateUserId: candidate.id, invitedName: person.fullName, respondedAt: new Date(), consentRecordId: consent.id } });
  });
  await recordSecurityEvent({ event: 'representation.granted', user: candidate, entityType: 'RepresentationConsent', entityId: r.id, summary: 'Candidate consented to representation', detail: { organizationId: r.organizationId, engagementId: r.engagementId, consentRecordId: granted.consentRecordId }, meta }, db, { strict: true });
  return granted;
}

/** The candidate takes it back: the consent record is revoked; a placement already made stands as the agency's record, but no NEW placement can cite this consent. */
export async function revokeRepresentation(candidate: { id: string; email: string }, id: string, meta?: RequestMeta) {
  const r = await db.representationConsent.findFirst({ where: { id, candidateUserId: candidate.id } });
  if (!r) throw new StaffingError('Request not found.', 404);
  if (r.status !== 'granted') throw new StaffingError('This representation is not granted.', 409);
  await db.$transaction(async (tx) => {
    await tx.representationConsent.update({ where: { id: r.id }, data: { status: 'revoked', respondedAt: new Date() } });
    if (r.consentRecordId) await tx.consentRecord.updateMany({ where: { id: r.consentRecordId, revokedAt: null }, data: { revokedAt: new Date() } });
  });
  await recordSecurityEvent({ event: 'representation.revoked', user: candidate, entityType: 'RepresentationConsent', entityId: r.id, summary: 'Candidate revoked representation', detail: { organizationId: r.organizationId, engagementId: r.engagementId }, meta }, db, { strict: true });
}

/** A GRANTED representation whose own consent record is current, or null. The one question a placement asks. */
async function currentRepresentation(client: Client, organizationId: string, id: string) {
  const r = await client.representationConsent.findFirst({ where: { id, organizationId } });
  if (!r || r.status !== 'granted' || !r.candidateUserId || !r.consentRecordId) return null;
  // The record must be THIS purpose at the CURRENT wording: a consent given
  // to older wording, or for another purpose, does not carry a placement
  // (Stage 19 review, M4).
  const consent = await db.consentRecord.findFirst({ where: { id: r.consentRecordId, userId: r.candidateUserId, purpose: 'agency_representation', version: CONSENT_VERSIONS.agency_representation, revokedAt: null }, select: { id: true } });
  return consent ? { ...r, candidateUserId: r.candidateUserId } : null;
}

// --- Placements ---------------------------------------------------------------------

/**
 * Place a represented candidate. The fee is computed from the structure and
 * frozen; the guarantee runs from the start date; the jurisdiction is
 * evaluated against the recorded rules and the evaluation stored. A
 * `blocked` verdict refuses; `unconfirmed` (rules not recorded, L-4) is
 * allowed here - the placement is the agency's own operational fact - but
 * no invoice is issued under it (issueInvoice).
 */
export async function createPlacement(tx: Client, actor: StaffingActor, input: { engagementId: string; representationConsentId: string; startDate: Date; salaryCents: number; currency?: 'CAD' | 'USD'; recruiterId?: string | null }) {
  const e = await ownedEngagement(tx, actor, input.engagementId);
  if (!canWritePlacement(actor.role, e, actor.user.id)) throw new StaffingError('You may not place on this engagement.', 403);
  if (e.status !== 'active') throw new StaffingError('The engagement is not active.', 409);
  if (!Number.isInteger(input.salaryCents) || input.salaryCents <= 0) throw new StaffingError('The salary is a positive amount in cents.', 422);
  const rep = await currentRepresentation(tx, actor.organizationId, input.representationConsentId);
  if (!rep || rep.engagementId !== e.id) throw new StaffingError('The candidate has not consented to representation for this engagement, or withdrew it.', 403);
  const [fee, contract, rules] = await Promise.all([tx.feeStructure.findFirstOrThrow({ where: { id: e.feeStructureId } }), ownedContract(tx, actor, e.contractId), rulesFor(tx)]);
  if (contract.status !== 'active') throw new StaffingError('The client contract is not active.', 409);
  // The placement is denominated as the fee structure is; a salary in another
  // currency would make the frozen fee meaningless (Stage 19 review, M7).
  if (input.currency && input.currency !== fee.currency) throw new StaffingError(`This engagement's fee structure is in ${fee.currency}; the salary is stated in that currency.`, 422);
  // The credited recruiter is a recruiter (or admin) of this agency; a
  // recruiter credits only themselves (Stage 19 review, M6).
  let recruiterId = e.ownerRecruiterId ?? (actor.role === 'recruiter' ? actor.user.id : null);
  if (input.recruiterId !== undefined && input.recruiterId !== null) {
    if (actor.role === 'recruiter' && input.recruiterId !== actor.user.id) throw new StaffingError('A recruiter credits their own placements only.', 403);
    const m = await findActiveMembership(tx, actor.organizationId, input.recruiterId);
    if (!m || (staffingRoleOf(m) !== 'recruiter' && staffingRoleOf(m) !== 'admin')) throw new StaffingError('The credited recruiter is a recruiter of this organisation.', 422);
    recruiterId = input.recruiterId;
  }
  const evaluation = evaluateJurisdiction(rules, { jurisdiction: e.jurisdiction, paidBy: fee.paidBy, guaranteeDays: fee.guaranteeDays, agencyLicenceStated: contract.agencyLicenceRef !== '' });
  if (evaluation.verdict === 'blocked') throw new StaffingError(`This placement is not allowed: ${evaluation.checks.filter((c) => c.status === 'fail').map((c) => c.reason).join(' ')}`, 422);
  const feeCents = computeFee(fee, input.salaryCents);
  const placement = await tx.placement.create({
    data: {
      organizationId: actor.organizationId,
      engagementId: e.id,
      candidateUserId: rep.candidateUserId,
      representationConsentId: rep.id,
      recruiterId,
      startDate: input.startDate,
      salaryCents: input.salaryCents,
      currency: fee.currency,
      feeCents,
      guaranteeDays: fee.guaranteeDays,
      guaranteeEndsAt: new Date(input.startDate.getTime() + fee.guaranteeDays * 86_400_000),
      jurisdictionCheck: JSON.stringify({ engine: JURISDICTION_ENGINE_VERSION, ...evaluation }),
      createdById: actor.user.id,
    },
  });
  await audit('staffing.placement.created', actor, 'Placement', placement.id, 'Placement created', { engagementId: e.id, feeCents, guaranteeDays: fee.guaranteeDays, jurisdiction: e.jurisdiction, verdict: evaluation.verdict });
  return placement;
}

export async function updatePlacementStatus(tx: Client, actor: StaffingActor, id: string, input: { status: 'started' | 'completed' | 'fell_off' | 'cancelled'; fellOffReason?: (typeof FELL_OFF_REASONS)[number]; fellOffAt?: Date }) {
  const p = await tx.placement.findFirst({ where: { id, organizationId: actor.organizationId } });
  if (!p) throw new StaffingError('Placement not found.', 404);
  const e = await ownedEngagement(tx, actor, p.engagementId);
  if (!canWritePlacement(actor.role, e, actor.user.id)) throw new StaffingError('You may not change this placement.', 403);
  // A fall-off is a departure AFTER starting - the only thing the guarantee
  // clock reads; a candidate who never started is `cancelled`, which no
  // credit and no productivity count treats as a guarantee event (Stage 19
  // review, M8/L17).
  const allowed: Record<string, string[]> = { pending: ['started', 'cancelled'], started: ['completed', 'fell_off'], completed: [], fell_off: [], cancelled: [] };
  if (!allowed[p.status]?.includes(input.status)) throw new StaffingError(`A ${p.status} placement cannot become ${input.status}.`, 409);
  let fellOffAt: Date | null = null;
  if (input.status === 'fell_off') {
    if (!input.fellOffReason) throw new StaffingError('A fall-off names its reason.', 422);
    fellOffAt = input.fellOffAt ?? new Date();
    if (Number.isNaN(fellOffAt.getTime())) throw new StaffingError('The fall-off date is not a date.', 422);
    if (fellOffAt < p.startDate) throw new StaffingError('A fall-off is not before the start date.', 422);
    if (fellOffAt.getTime() > Date.now() + 5 * 60_000) throw new StaffingError('A fall-off is not in the future.', 422);
  }
  const updated = await tx.placement.update({ where: { id: p.id }, data: { status: input.status, ...(fellOffAt ? { fellOffAt, fellOffReason: input.fellOffReason } : {}) } });
  await audit('staffing.placement.updated', actor, 'Placement', p.id, `Placement ${input.status}`, { status: input.status, fellOffReason: input.fellOffReason ?? null, withinGuarantee: fellOffAt ? fellOffAt <= p.guaranteeEndsAt : null });
  return updated;
}

/** Whether a fall-off happened inside the guarantee period (the client is owed a credit or a replacement under the structure). */
export function withinGuarantee(p: { status: string; fellOffAt: Date | null; guaranteeEndsAt: Date }): boolean {
  return p.status === 'fell_off' && p.fellOffAt !== null && p.fellOffAt <= p.guaranteeEndsAt;
}

// --- Placement invoicing (the agency -> its client; never the candidate) ---------------

/**
 * Issue the invoice for a placement to the CLIENT. Its number comes from
 * the `PL` book inside the same transaction; the amount is the frozen fee.
 * Refused unless the jurisdiction's rules are RECORDED and every check
 * passes (an unknown is not a pass where money is concerned - L-4), the
 * contract is active, and the placement has started or completed.
 */
export async function issuePlacementInvoice(tx: Client, actor: StaffingActor, placementId: string, input: { dueDays?: number } = {}) {
  if (!canInvoice(actor.role)) throw new StaffingError('Only finance or an administrator invoices.', 403);
  const p = await tx.placement.findFirst({ where: { id: placementId, organizationId: actor.organizationId } });
  if (!p) throw new StaffingError('Placement not found.', 404);
  if (p.status !== 'started' && p.status !== 'completed') throw new StaffingError(`A ${p.status} placement is not invoiced.`, 409);
  const [e, rules] = await Promise.all([tx.engagement.findFirstOrThrow({ where: { id: p.engagementId } }), rulesFor(tx)]);
  const [contract, fee] = await Promise.all([ownedContract(tx, actor, e.contractId), tx.feeStructure.findFirstOrThrow({ where: { id: e.feeStructureId } })]);
  if (contract.status !== 'active') throw new StaffingError('The client contract is not active.', 409);
  const evaluation = evaluateJurisdiction(rules, { jurisdiction: e.jurisdiction, paidBy: fee.paidBy, guaranteeDays: p.guaranteeDays, agencyLicenceStated: contract.agencyLicenceRef !== '' });
  if (evaluation.verdict !== 'allowed') throw new StaffingError(`No invoice is issued under ${e.jurisdiction} until its rules are recorded and pass (L-4): ${evaluation.checks.filter((c) => c.status !== 'pass').map((c) => c.reason).join(' ')}`, 409);
  const openInvoices = (client: Client) => client.placementInvoice.count({ where: { placementId: p.id, status: { in: ['draft', 'issued', 'paid'] } } });
  if ((await openInvoices(tx)) > 0) throw new StaffingError('This placement is already invoiced.', 409);
  const now = new Date();
  // The number and the row are written in ONE system-client transaction: the
  // numbering book (`DocumentSequence`) is system-only under RLS, as it is for
  // every document on the platform, and a rolled-back issue must give its
  // number back. Every check above ran on the tenant path; the write carries
  // the organisation id the actor was resolved for. Two finance users issuing
  // at once serialise on a transaction-scoped advisory lock keyed by the
  // placement, and the "already invoiced" check is repeated UNDER that lock,
  // so the second sees the first's committed row (Stage 19 review, H3).
  const invoice = await db.$transaction(async (sys) => {
    await sys.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'placement_invoice:' + p.id}))`;
    if ((await openInvoices(sys)) > 0) throw new StaffingError('This placement is already invoiced.', 409);
    const allocated = await allocateDocumentNumber(prismaSequenceStore(sys), { scope: 'placement_invoice', series: 'PL', year: now.getUTCFullYear() });
    return sys.placementInvoice.create({ data: { organizationId: actor.organizationId, placementId: p.id, contractId: contract.id, number: allocated.number, status: 'issued', amountCents: p.feeCents, currency: p.currency, issuedAt: now, dueAt: new Date(now.getTime() + (input.dueDays ?? 30) * 86_400_000), createdById: actor.user.id } });
  });
  await audit('staffing.invoice.issued', actor, 'PlacementInvoice', invoice.id, `Placement invoice ${invoice.number} issued`, { placementId: p.id, contractId: contract.id, amountCents: invoice.amountCents, currency: invoice.currency });
  return invoice;
}

export async function updatePlacementInvoice(tx: Client, actor: StaffingActor, id: string, input: { action: 'paid' } | { action: 'void'; reason: (typeof INVOICE_VOID_REASONS)[number] } | { action: 'credit_guarantee' }) {
  if (!canInvoice(actor.role)) throw new StaffingError('Only finance or an administrator invoices.', 403);
  const inv = await tx.placementInvoice.findFirst({ where: { id, organizationId: actor.organizationId } });
  if (!inv) throw new StaffingError('Invoice not found.', 404);
  let updated;
  if (input.action === 'paid') {
    if (inv.status !== 'issued') throw new StaffingError(`A ${inv.status} invoice is not marked paid.`, 409);
    updated = await tx.placementInvoice.update({ where: { id: inv.id }, data: { status: 'paid', paidAt: new Date() } });
  } else if (input.action === 'void') {
    if (inv.status !== 'issued') throw new StaffingError(`A ${inv.status} invoice is not voided; a paid one is credited.`, 409);
    if (inv.creditedCents > 0) throw new StaffingError('A credited invoice is not voided; the credit is the record.', 409);
    updated = await tx.placementInvoice.update({ where: { id: inv.id }, data: { status: 'void', voidedAt: new Date(), voidReason: input.reason } });
  } else {
    const p = await tx.placement.findFirstOrThrow({ where: { id: inv.placementId } });
    if (!withinGuarantee(p)) throw new StaffingError('A guarantee credit needs a fall-off inside the guarantee period.', 409);
    if (inv.status !== 'issued' && inv.status !== 'paid') throw new StaffingError(`A ${inv.status} invoice is not credited.`, 409);
    if (inv.creditedCents > 0) throw new StaffingError('This invoice is already credited.', 409);
    updated = await tx.placementInvoice.update({ where: { id: inv.id }, data: { creditedCents: inv.amountCents, creditReason: 'guarantee_fell_off' } });
  }
  await audit('staffing.invoice.updated', actor, 'PlacementInvoice', inv.id, `Placement invoice ${input.action}`, { action: input.action, amountCents: inv.amountCents, creditedCents: updated.creditedCents });
  return updated;
}

export async function listPlacementInvoices(tx: Client, actor: StaffingActor) {
  if (!canReadInvoice(actor.role)) throw new StaffingError('You may not read invoices.', 403);
  return tx.placementInvoice.findMany({ where: { organizationId: actor.organizationId }, orderBy: { createdAt: 'desc' }, include: { contract: { select: { clientName: true } }, placement: { select: { engagementId: true, startDate: true } } } });
}

// --- Recruiter productivity ---------------------------------------------------------------

/** Per recruiter: engagements owned, representations requested and granted, placements, fall-offs inside guarantee, fees (finance and admin; a recruiter sees their own row only). */
export async function recruiterProductivity(tx: Client, actor: StaffingActor, range: { from: Date; to: Date }) {
  if (!canReadProductivity(actor.role)) throw new StaffingError('You may not read productivity.', 403);
  // Stage 21 (ADR-0036): mart rows (OrganizationDailyMart, product staffing),
  // never the engagement, representation or placement tables. Fees only for
  // the roles that read fees; a recruiter sees their own row only.
  const recruiters = await readStaffingProductivity(tx, actor.organizationId, range, { fees: canReadFee(actor.role), onlyRecruiterId: actor.role === 'recruiter' ? actor.user.id : undefined });
  const invoices = canReadInvoice(actor.role) ? await readStaffingInvoices(tx, actor.organizationId, range) : null;
  return { range, recruiters, invoices };
}
