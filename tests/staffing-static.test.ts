/**
 * Stage 19 (ADR-0034) - the pure parts of staffing: the jurisdiction engine
 * over recorded rules (an unknown is never a pass; the platform rule that
 * the client pays holds everywhere), the fee arithmetic, the roles as a
 * named set, the agency-representation consent as a draft, and the static
 * separation between placement invoicing and candidate billing.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { SEEDED_JURISDICTIONS, computeFee, evaluateJurisdiction, isJurisdictionCode, resolveRule, type JurisdictionRuleRow } from '../src/lib/staffing/jurisdiction';
import { LIMITS } from '../src/lib/rate-limit';
import { STAFFING_ROLES, canInvoice, canReadFee, canRequestRepresentation, canWriteContract, canWriteEngagement, canWriteFee, staffingRoleOf } from '../src/lib/staffing/roles';
import { CONSENT_PURPOSES, CONSENT_VERSIONS, SELF_SERVICE_PURPOSES } from '../src/lib/consent';
import { SEQUENCE_STYLES } from '../src/lib/billing/numbering';

const row = (jurisdiction: string, over: Partial<JurisdictionRuleRow> = {}): JurisdictionRuleRow => ({ jurisdiction, name: jurisdiction, status: 'unrecorded', licenceRequired: null, candidateFeesProhibited: null, maxGuaranteeDays: null, ...over });
const facts = (jurisdiction: string, over: Partial<Parameters<typeof evaluateJurisdiction>[1]> = {}) => ({ jurisdiction, paidBy: 'client', guaranteeDays: 90, agencyLicenceStated: true, ...over });

describe('jurisdiction rules are data; the engine is pure', () => {
  it('codes are COUNTRY or COUNTRY-REGION; the seeded list carries names only and no rule value', () => {
    for (const c of ['CA', 'CA-BC', 'US-NY']) assert.ok(isJurisdictionCode(c), c);
    for (const c of ['ca-bc', 'Canada', 'CA_BC', '']) assert.ok(!isJurisdictionCode(c), c);
    assert.ok(SEEDED_JURISDICTIONS.some((j) => j.jurisdiction === 'CA-BC') && SEEDED_JURISDICTIONS.some((j) => j.jurisdiction === 'US'));
    for (const j of SEEDED_JURISDICTIONS) assert.deepEqual(Object.keys(j).sort(), ['jurisdiction', 'name'], 'nothing about a jurisdiction is asserted in code');
  });

  it('the most specific ANSWERED rule wins: CA-BC over CA; a region with no row falls back to its country; nothing else matches', () => {
    const rules = [row('CA', { status: 'recorded' }), row('CA-BC', { status: 'recorded', licenceRequired: true })];
    assert.equal(resolveRule(rules, 'CA-BC')?.jurisdiction, 'CA-BC');
    assert.equal(resolveRule(rules, 'CA-ON')?.jurisdiction, 'CA');
    assert.equal(resolveRule(rules, 'US-NY'), null);
    assert.equal(resolveRule([row('CA')], 'CA')?.jurisdiction, 'CA', 'a bare country matches its own row');
    assert.equal(resolveRule([row('CA-BC')], 'CA'), null, 'a region never governs its country');
  });

  it('review H2: an UNRECORDED region row never shadows an answer recorded at country level, and a prohibition at country level blocks every region', () => {
    const prohibitedCountry = [row('CA', { status: 'prohibited' }), row('CA-BC')];
    assert.equal(resolveRule(prohibitedCountry, 'CA-BC')?.jurisdiction, 'CA', 'the prohibition governs, not the empty region row');
    const blocked = evaluateJurisdiction(prohibitedCountry, facts('CA-BC'));
    assert.equal(blocked.verdict, 'blocked');
    assert.ok(blocked.checks.some((c) => c.rule === 'jurisdiction_recorded' && c.status === 'fail' && /CA governs CA-BC/.test(c.reason)));
    const recordedCountry = [row('CA', { status: 'recorded', licenceRequired: false, candidateFeesProhibited: true, maxGuaranteeDays: null }), row('CA-BC')];
    assert.equal(resolveRule(recordedCountry, 'CA-BC')?.jurisdiction, 'CA');
    assert.equal(evaluateJurisdiction(recordedCountry, facts('CA')).verdict, 'allowed', 'the country itself is confirmed');
    // an answered region beats an answered country either way
    const both = [row('CA', { status: 'prohibited' }), row('CA-BC', { status: 'recorded', licenceRequired: false, candidateFeesProhibited: true, maxGuaranteeDays: null })];
    assert.equal(evaluateJurisdiction(both, facts('CA-BC')).verdict, 'allowed');
    assert.equal(evaluateJurisdiction([row('CA', { status: 'recorded', licenceRequired: false, candidateFeesProhibited: true, maxGuaranteeDays: null }), row('CA-BC', { status: 'prohibited' })], facts('CA-BC')).verdict, 'blocked');
  });

  it('review H2: a country\'s recorded answer does not CONFIRM a region it was not recorded for - an unseeded province under a recorded country is unconfirmed, never allowed', () => {
    const rules = [row('CA', { status: 'recorded', licenceRequired: false, candidateFeesProhibited: true, maxGuaranteeDays: 90 })];
    const sk = evaluateJurisdiction(rules, facts('CA-SK'));
    assert.equal(sk.matched, 'CA');
    assert.equal(sk.verdict, 'unconfirmed');
    assert.ok(sk.checks.some((c) => c.rule === 'jurisdiction_recorded' && c.status === 'unknown' && /does not confirm a region/.test(c.reason)));
    assert.equal(evaluateJurisdiction(rules, facts('CA-SK', { guaranteeDays: 365 })).verdict, 'blocked', 'but a limit the country recorded still fails a region that exceeds it');
  });

  it('an unrecorded jurisdiction is UNCONFIRMED (unknown is never a pass); a prohibited one is BLOCKED', () => {
    const u = evaluateJurisdiction([row('CA-BC')], facts('CA-BC'));
    assert.equal(u.verdict, 'unconfirmed');
    assert.ok(u.checks.every((c) => c.status !== 'pass' || c.rule === 'candidate_fees'));
    assert.equal(evaluateJurisdiction([], facts('US-TX')).verdict, 'unconfirmed');
    const p = evaluateJurisdiction([row('US-CA', { status: 'prohibited' })], facts('US-CA'));
    assert.equal(p.verdict, 'blocked');
    assert.ok(p.checks.some((c) => c.rule === 'jurisdiction_recorded' && c.status === 'fail'));
  });

  it('a recorded jurisdiction evaluates licence, candidate fees and the guarantee limit from the ROW; BC and Ontario and a US state differ only by what counsel recorded', () => {
    const rules = [
      row('CA-BC', { status: 'recorded', licenceRequired: true, candidateFeesProhibited: true, maxGuaranteeDays: 120 }),
      row('CA-ON', { status: 'recorded', licenceRequired: false, candidateFeesProhibited: true, maxGuaranteeDays: null }),
      row('US-WA', { status: 'recorded', licenceRequired: null, candidateFeesProhibited: null, maxGuaranteeDays: 90 }),
    ];
    assert.equal(evaluateJurisdiction(rules, facts('CA-BC')).verdict, 'allowed');
    assert.equal(evaluateJurisdiction(rules, facts('CA-BC', { agencyLicenceStated: false })).verdict, 'blocked', 'BC: a licence is required and none is stated');
    assert.equal(evaluateJurisdiction(rules, facts('CA-BC', { guaranteeDays: 180 })).verdict, 'blocked', 'BC: over the recorded guarantee limit');
    assert.equal(evaluateJurisdiction(rules, facts('CA-ON', { agencyLicenceStated: false, guaranteeDays: 365 })).verdict, 'allowed', 'Ontario as recorded: no licence, no limit');
    const wa = evaluateJurisdiction(rules, facts('US-WA'));
    assert.equal(wa.verdict, 'unconfirmed', 'Washington: recorded, but two answers were left blank');
    assert.deepEqual(wa.checks.filter((c) => c.status === 'unknown').map((c) => c.rule), ['candidate_fees', 'licence']);
  });

  it('the platform rule: a fee not paid by the client FAILS in every jurisdiction, recorded or not', () => {
    for (const rules of [[], [row('CA-BC', { status: 'recorded', licenceRequired: false, candidateFeesProhibited: false, maxGuaranteeDays: null })]]) {
      const e = evaluateJurisdiction(rules, facts('CA-BC', { paidBy: 'candidate' }));
      assert.equal(e.verdict, 'blocked');
      assert.ok(e.checks.some((c) => c.rule === 'candidate_fees' && c.status === 'fail' && /No candidate is charged/.test(c.reason)));
    }
  });

  it('fees are deterministic: contingency and retained by basis points, flat as stated, rounded half up', () => {
    assert.equal(computeFee({ kind: 'contingency', percentBps: 2000, flatCents: null }, 9_000_000), 1_800_000);
    assert.equal(computeFee({ kind: 'retained', percentBps: 2500, flatCents: null }, 10_000_001), 2_500_000);
    assert.equal(computeFee({ kind: 'flat', percentBps: null, flatCents: 500_000 }, 9_000_000), 500_000);
    assert.equal(computeFee({ kind: 'contingency', percentBps: 1, flatCents: null }, 5_000), 1);
  });
});

describe('staffing roles - a named set over the organisation ladder', () => {
  const owned = { ownerRecruiterId: 'rec' };
  it('owner and admin are admin; unknown or null is a viewer, who sees nothing commercial', () => {
    assert.equal(staffingRoleOf({ role: 'owner', serviceRole: null }), 'admin');
    assert.equal(staffingRoleOf({ role: 'member', serviceRole: 'finance' }), 'finance');
    assert.equal(staffingRoleOf({ role: 'member', serviceRole: 'partner' }), 'viewer');
    assert.deepEqual([...STAFFING_ROLES], ['recruiter', 'delivery', 'finance', 'viewer']);
    assert.ok(!canReadFee('viewer') && !canWriteEngagement('viewer', owned, 'v'));
  });
  it('who may do what matches the matrix: admin writes contracts and fees; a recruiter owns; delivery writes engagements and placements; finance invoices and reads fees but never asks for representation', () => {
    assert.ok(canWriteContract('admin') && !canWriteContract('recruiter') && !canWriteContract('finance'));
    assert.ok(canWriteFee('admin') && !canWriteFee('recruiter') && canReadFee('finance') && !canReadFee('delivery'));
    assert.ok(canWriteEngagement('recruiter', owned, 'rec') && !canWriteEngagement('recruiter', owned, 'other') && canWriteEngagement('delivery', owned, 'x') && !canWriteEngagement('finance', owned, 'x'));
    assert.ok(canRequestRepresentation('recruiter', owned, 'rec') && !canRequestRepresentation('delivery', owned, 'x') && !canRequestRepresentation('finance', owned, 'x'));
    assert.ok(canInvoice('finance') && canInvoice('admin') && !canInvoice('recruiter') && !canInvoice('delivery'));
  });
  it('an engagement with no owner is open to EVERY recruiter of the agency (stated, not accidental - review L13); one with an owner is that recruiter\'s', () => {
    const unowned = { ownerRecruiterId: null };
    assert.ok(canWriteEngagement('recruiter', unowned, 'anyone') && canRequestRepresentation('recruiter', unowned, 'anyone'));
    assert.ok(!canWriteEngagement('recruiter', owned, 'anyone') && !canRequestRepresentation('recruiter', owned, 'anyone'));
  });
});

describe('review H1 and M10 - the request and governance surfaces are bounded', () => {
  const root = path.resolve(__dirname, '..');
  it('a staffing agency is a VERIFIED organisation type (staff-created), and a representation request is rate-limited per recruiter and per agency', () => {
    const orgs = readFileSync(path.join(root, 'src/lib/tenancy/organizations.ts'), 'utf8');
    assert.match(orgs, /VERIFIED_TYPES[^\n]*new Set\(\[[^\]]*'staffing_agency'/);
    const service = readFileSync(path.join(root, 'src/lib/staffing/service.ts'), 'utf8');
    assert.match(service, /rateLimit\('staffing:represent', actor\.user\.id, LIMITS\.representationRequest\)/);
    assert.match(service, /rateLimit\('staffing:represent:org', actor\.organizationId, LIMITS\.representationRequestOrganization\)/);
    assert.ok(LIMITS.representationRequest.limit <= LIMITS.caseInvite.limit && LIMITS.representationRequestOrganization.limit <= LIMITS.caseInviteOrganization.limit, 'no looser than case invitations');
  });
  it('recording counsel\'s answer (L-4) is a governance route under step-up; the registry read writes nothing; the invoice issue holds an advisory lock and re-checks under it', () => {
    const route = readFileSync(path.join(root, 'src/app/(app)/api/console/staffing/jurisdictions/route.ts'), 'utf8');
    assert.match(route, /export const PATCH = governanceRoute\(/);
    assert.match(route, /await requireStepUp\(staff, body\.currentPassword, requestMeta\(request\)\)/);
    assert.match(route, /export const GET = governanceRoute\([\s\S]*listJurisdictionRegistry\(\)/);
    assert.ok(!/export const GET[\s\S]*?ensureJurisdictionRegistry[\s\S]*?\n\}\);\n\nconst schema/.test(route), 'GET does not upsert');
    const service = readFileSync(path.join(root, 'src/lib/staffing/service.ts'), 'utf8');
    assert.match(service, /consentRecord\.findFirst\(\{ where: \{ id: r\.consentRecordId, userId: r\.candidateUserId, purpose: 'agency_representation', version: CONSENT_VERSIONS\.agency_representation, revokedAt: null \}/, 'a placement cites a consent of THIS purpose at the CURRENT wording (review M4)');
    const issue = service.slice(service.indexOf('export async function issuePlacementInvoice'), service.indexOf('export async function updatePlacementInvoice'));
    assert.match(issue, /db\.\$transaction\(async \(sys\) => \{\s*await sys\.\$executeRaw`SELECT pg_advisory_xact_lock\(hashtext\(/);
    assert.ok(issue.indexOf('pg_advisory_xact_lock') < issue.indexOf('await openInvoices(sys)') && issue.indexOf('await openInvoices(sys)') < issue.indexOf('allocateDocumentNumber'), 'lock, re-check, then allocate');
  });
});

describe('the agency_representation consent and the placement-invoice series', () => {
  it('is a purpose with a DRAFT version (L-5), not self-service; placement invoices have their own book', () => {
    assert.ok((CONSENT_PURPOSES as readonly string[]).includes('agency_representation'));
    assert.match(CONSENT_VERSIONS.agency_representation, /-draft$/);
    assert.ok(!(SELF_SERVICE_PURPOSES as readonly string[]).includes('agency_representation'));
    assert.deepEqual(SEQUENCE_STYLES.placement_invoice, { series: 'PL', prefix: 'PL-', padding: 6 });
    assert.notEqual(SEQUENCE_STYLES.placement_invoice.series, SEQUENCE_STYLES.invoice.series);
  });
});

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* files(full);
    else if (/\.(ts|tsx)$/.test(entry)) yield full;
  }
}

describe('separation - employer-paid placement and candidate-paid subscriptions never share a billing path', () => {
  const root = path.resolve(__dirname, '..');
  const BILLING_TABLES = 'invoice|invoiceLine|payment|paymentAllocation|subscription|entitlement|creditNote|refund|billingProfile|planPrice|plan';
  const STAFFING_TABLES = 'placement|placementInvoice|engagement|clientContract|feeStructure|representationConsent|staffingJurisdictionRule';
  /** Any client access to a model - every delegate method, not a list of them - and any raw SQL naming its table (review M9). */
  const touches = (tables: string) => new RegExp(`\\.(${tables})\\.[a-zA-Z]+\\(|\\$(queryRaw|executeRaw|queryRawUnsafe|executeRawUnsafe)[^;]*"(${tables.split('|').map((t) => t[0]!.toUpperCase() + t.slice(1)).join('|')})"`);
  it('nothing under src/lib/staffing imports the subscription, entitlement, invoice, dunning, tax or payment modules (by alias OR relative path), nor touches their tables by any delegate method or raw SQL', () => {
    for (const f of files(path.join(root, 'src/lib/staffing'))) {
      const text = readFileSync(f, 'utf8');
      const rel = path.relative(root, f);
      assert.ok(!/lib\/subscription|lib\/entitlements|lib\/billing\/(invoice|dunning|tax|profile|webhook-events)|lib\/providers\/payments|stripe|paypal/i.test(text), `${rel} touches candidate billing`);
      for (const m of text.matchAll(/from\s+'(\.\.?\/[^']*)'/g)) {
        const target = path.normalize(path.join(path.dirname(f), m[1]!));
        assert.ok(target.startsWith(path.join(root, 'src/lib/staffing')), `${rel} imports outside the module by relative path (${m[1]}); use the alias so the separation test sees it`);
      }
      assert.ok(!touches(BILLING_TABLES).test(text), `${rel} reads or writes a candidate billing table`);
      assert.ok(!/lib\/sensitive|lib\/ai\/gateway|lib\/ai\/providers|lib\/mailbox/.test(text), `${rel} reaches a forbidden path`);
    }
  });
  it('the schema gives PlacementInvoice no user id and no relation to Invoice or Payment; a fee structure carries who pays', () => {
    const schema = readFileSync(path.join(root, 'prisma/schema.prisma'), 'utf8');
    const block = schema.slice(schema.indexOf('model PlacementInvoice {'), schema.indexOf('}', schema.indexOf('model PlacementInvoice {')));
    assert.ok(!/userId|Invoice\b[^s]|Payment\b|Subscription/.test(block.replace('model PlacementInvoice {', '')), 'no candidate, no candidate billing');
    assert.match(schema.slice(schema.indexOf('model FeeStructure {')), /paidBy\s+String\s+@default\("client"\)/);
  });
  it('nothing under the candidate billing modules (subscription.ts included) touches a placement or a staffing table by any delegate method or raw SQL, nor imports the staffing module', () => {
    const offenders: string[] = [];
    const candidates = ['src/lib/subscription.ts', ...['src/lib/billing', 'src/lib/entitlements', 'src/lib/providers/payments'].flatMap((dir) => [...files(path.join(root, dir))].map((f) => path.relative(root, f)))];
    for (const rel of candidates) {
      const text = readFileSync(path.join(root, rel), 'utf8');
      if (touches(STAFFING_TABLES).test(text) || /lib\/staffing/.test(text)) offenders.push(rel);
    }
    assert.ok(candidates.includes('src/lib/subscription.ts'));
    assert.deepEqual(offenders, []);
  });
});
