/**
 * Stage 19 (ADR-0034) - jurisdictional staffing rules as DATA, and a pure
 * engine over them.
 *
 * The brief's requirement: Canadian recruiter and staffing rules are
 * configuration, never hardcoded globals. So nothing here states what British
 * Columbia or New York requires. `StaffingJurisdictionRule` rows are seeded
 * `unrecorded` for the jurisdictions the product targets, and counsel's
 * answer (L-4, COMPLIANCE_REGISTER.md) is RECORDED by staff at
 * /console/staffing: whether a licence is required, whether fees to a
 * candidate are prohibited, the longest guarantee allowed, the citation.
 * Until a jurisdiction is recorded every check about it answers `unknown`,
 * and an unknown is NOT a pass: a placement may be recorded (the agency's
 * own operational fact) but no invoice is issued under a jurisdiction whose
 * rules are unrecorded or prohibited (service.ts). The engine never reads
 * the database; the service hands it the rows.
 *
 * One rule IS the platform's, not a jurisdiction's: a fee structure whose
 * payer is not the client is refused everywhere. No candidate is charged on
 * an employer-paid engagement, in any jurisdiction, by construction.
 */

export type RuleStatus = 'unrecorded' | 'recorded' | 'prohibited';

export interface JurisdictionRuleRow {
  jurisdiction: string;
  name: string;
  status: string;
  licenceRequired: boolean | null;
  candidateFeesProhibited: boolean | null;
  maxGuaranteeDays: number | null;
}

export type CheckStatus = 'pass' | 'fail' | 'unknown';

export interface JurisdictionCheck {
  rule: 'jurisdiction_recorded' | 'licence' | 'candidate_fees' | 'guarantee_period';
  status: CheckStatus;
  reason: string;
}

export interface JurisdictionEvaluation {
  jurisdiction: string;
  /** The row the evaluation used (most specific match), or null. */
  matched: string | null;
  checks: JurisdictionCheck[];
  /** `allowed` only when every check passes; `blocked` on any fail; `unconfirmed` when something is unknown and nothing fails. */
  verdict: 'allowed' | 'blocked' | 'unconfirmed';
}

export const JURISDICTION_ENGINE_VERSION = '2026-09-05.1';

/** The jurisdictions seeded as rows. Names only; every rule value is null until counsel records it. */
export const SEEDED_JURISDICTIONS: { jurisdiction: string; name: string }[] = [
  { jurisdiction: 'CA', name: 'Canada (federal fallback)' },
  { jurisdiction: 'CA-BC', name: 'British Columbia' },
  { jurisdiction: 'CA-AB', name: 'Alberta' },
  { jurisdiction: 'CA-ON', name: 'Ontario' },
  { jurisdiction: 'CA-QC', name: 'Quebec' },
  { jurisdiction: 'US', name: 'United States (federal fallback)' },
  { jurisdiction: 'US-CA', name: 'California' },
  { jurisdiction: 'US-NY', name: 'New York' },
  { jurisdiction: 'US-TX', name: 'Texas' },
  { jurisdiction: 'US-WA', name: 'Washington' },
];

/** `CA-BC` matches `CA-BC` then `CA`; a bare `CA` matches itself only. Codes are upper-case, `COUNTRY` or `COUNTRY-REGION`. */
export function isJurisdictionCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z]{2}(-[A-Z0-9]{2,3})?$/.test(value);
}

export function resolveRule(rules: readonly JurisdictionRuleRow[], jurisdiction: string): JurisdictionRuleRow | null {
  const exact = rules.find((r) => r.jurisdiction === jurisdiction);
  if (exact) return exact;
  const country = jurisdiction.split('-')[0]!;
  return rules.find((r) => r.jurisdiction === country) ?? null;
}

export interface PlacementFacts {
  jurisdiction: string;
  /** Who the fee structure says pays. Anything but `client` is a platform-level fail. */
  paidBy: string;
  guaranteeDays: number;
  /** Whether the agency recorded a licence for this jurisdiction on its contract (a statement, not a verification). */
  agencyLicenceStated: boolean;
}

export function evaluateJurisdiction(rules: readonly JurisdictionRuleRow[], facts: PlacementFacts): JurisdictionEvaluation {
  const rule = resolveRule(rules, facts.jurisdiction);
  const checks: JurisdictionCheck[] = [];

  if (!rule) checks.push({ rule: 'jurisdiction_recorded', status: 'unknown', reason: `No rule row exists for ${facts.jurisdiction}; counsel has not been asked about it (L-4).` });
  else if (rule.status === 'prohibited') checks.push({ rule: 'jurisdiction_recorded', status: 'fail', reason: `${rule.name}: counsel recorded that this platform must not place candidates here.` });
  else if (rule.status !== 'recorded') checks.push({ rule: 'jurisdiction_recorded', status: 'unknown', reason: `${rule.name}: the rules are not recorded yet (L-4).` });
  else checks.push({ rule: 'jurisdiction_recorded', status: 'pass', reason: `${rule.name}: rules recorded${rule.jurisdiction === facts.jurisdiction ? '' : ` (${rule.jurisdiction} applies to ${facts.jurisdiction})`}.` });

  // Platform rule, in every jurisdiction.
  if (facts.paidBy !== 'client') checks.push({ rule: 'candidate_fees', status: 'fail', reason: 'The fee is not paid by the client. No candidate is charged on an employer-paid engagement, anywhere.' });
  else if (rule?.status === 'recorded' && rule.candidateFeesProhibited === null) checks.push({ rule: 'candidate_fees', status: 'unknown', reason: `${rule.name}: whether candidate fees are prohibited was not recorded; the client pays regardless.` });
  else checks.push({ rule: 'candidate_fees', status: 'pass', reason: 'The client pays the fee.' });

  if (rule?.status === 'recorded') {
    if (rule.licenceRequired === null) checks.push({ rule: 'licence', status: 'unknown', reason: `${rule.name}: whether an agency licence is required was not recorded.` });
    else if (!rule.licenceRequired) checks.push({ rule: 'licence', status: 'pass', reason: `${rule.name}: no agency licence is required.` });
    else if (facts.agencyLicenceStated) checks.push({ rule: 'licence', status: 'pass', reason: `${rule.name}: a licence is required and the agency stated one on the contract (not verified by this platform).` });
    else checks.push({ rule: 'licence', status: 'fail', reason: `${rule.name}: an agency licence is required and none is stated on the contract.` });

    if (rule.maxGuaranteeDays === null) checks.push({ rule: 'guarantee_period', status: 'pass', reason: `${rule.name}: no limit on the guarantee period was recorded.` });
    else if (facts.guaranteeDays <= rule.maxGuaranteeDays) checks.push({ rule: 'guarantee_period', status: 'pass', reason: `${rule.name}: ${facts.guaranteeDays} days is within the ${rule.maxGuaranteeDays}-day limit.` });
    else checks.push({ rule: 'guarantee_period', status: 'fail', reason: `${rule.name}: ${facts.guaranteeDays} days exceeds the ${rule.maxGuaranteeDays}-day limit.` });
  } else {
    checks.push({ rule: 'licence', status: rule?.status === 'prohibited' ? 'fail' : 'unknown', reason: 'Not evaluated: the jurisdiction is not recorded.' });
    checks.push({ rule: 'guarantee_period', status: rule?.status === 'prohibited' ? 'fail' : 'unknown', reason: 'Not evaluated: the jurisdiction is not recorded.' });
  }

  const verdict = checks.some((c) => c.status === 'fail') ? 'blocked' : checks.some((c) => c.status === 'unknown') ? 'unconfirmed' : 'allowed';
  return { jurisdiction: facts.jurisdiction, matched: rule?.jurisdiction ?? null, checks, verdict };
}

/** The fee a structure yields for a salary, in cents; deterministic, rounded half up. */
export function computeFee(structure: { kind: string; percentBps: number | null; flatCents: number | null }, salaryCents: number): number {
  if (structure.kind === 'flat') return structure.flatCents ?? 0;
  const bps = structure.percentBps ?? 0;
  return Math.round((salaryCents * bps) / 10_000);
}
