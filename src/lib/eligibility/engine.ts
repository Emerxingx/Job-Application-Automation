/**
 * Stage 07 — the eligibility engine (JOB_INTELLIGENCE_ARCHITECTURE
 * "Eligibility engine (Stage 07) — distinct from scoring").
 *
 * Hard pass / fail gates, evaluated BEFORE and apart from fit. Pure and
 * deterministic: the same candidate facts and job facts always yield the
 * same verdict, and every rule states its reason in words a candidate can
 * act on. There is no number anywhere in the output.
 *
 * Three honesty rules govern every gate:
 *   1. `unknown` never excludes. A rule fails only on a statement the posting
 *      made and a fact the candidate recorded; when either side is silent
 *      the rule is `unknown` and the job still reaches scoring, flagged.
 *   2. The engine reads work authorisation, preferences, certifications and
 *      languages — never the sensitive schema (ADR-0007; a static test
 *      enforces it).
 *   3. What the extraction cannot yet tell apart is not gated on. The Stage
 *      06 canonical job lists certifications and languages the posting
 *      MENTIONS without separating required from preferred, so those two
 *      rules are advisory (pass / unknown) except for a licensed
 *      designation the title itself demands. Stage 08's requirement
 *      extraction upgrades them.
 *
 * Jurisdiction: Canada and the US, by the posting's country. A rule that
 * depends on a jurisdiction it does not model answers `unknown`.
 */

export const RULES_VERSION = '2026-09-03.1';

export type RuleId = 'work_authorization' | 'sponsorship' | 'security_clearance' | 'location' | 'licensure' | 'language';
export type RuleStatus = 'pass' | 'fail' | 'unknown';
export type Outcome = 'eligible' | 'ineligible' | 'unknown';

export interface RuleResult {
  rule: RuleId;
  status: RuleStatus;
  /** Human-readable, addressed to the candidate. Never a score. */
  reason: string;
  /** A hard gate can exclude; an advisory rule can only pass or leave a question open. */
  hard: boolean;
}

export interface EligibilityVerdict {
  outcome: Outcome;
  rules: RuleResult[];
  rulesVersion: string;
}

/** What the engine may know about the candidate. Nothing else is read. */
export interface CandidateEligibility {
  workAuth: {
    country: string;
    status: string; // citizen | permanent_resident | work_permit | study_permit | requires_sponsorship | other | unspecified
    permitExpiresAt: string | null; // YYYY-MM-DD
    sponsorshipNeeded: boolean;
  } | null;
  preferences: {
    countries: string[];
    locations: string[];
    workModes: string[];
    relocation: string; // no | open | yes
  } | null;
  certifications: string[];
  languages: { language: string; proficiency: string }[];
}

/** What the engine reads from the canonical job (Stage 06). */
export interface JobEligibilityFacts {
  title: string;
  country: string;
  location: string;
  postalRegion: string | null;
  workMode: string;
  workAuthorization: string | null;
  sponsorship: string;
  certificationRequirements: string[];
  languageRequirements: string[];
}

const COUNTRY_NAME: Record<string, string> = { CA: 'Canada', US: 'the United States' };
const MODELLED = new Set(['CA', 'US']);

function countryName(code: string): string {
  return COUNTRY_NAME[code] ?? code;
}

function needsSponsorship(c: CandidateEligibility): boolean {
  return Boolean(c.workAuth && (c.workAuth.sponsorshipNeeded || c.workAuth.status === 'requires_sponsorship'));
}

function permitExpired(permitExpiresAt: string | null, today: Date): boolean {
  if (!permitExpiresAt) return false;
  const expiry = new Date(`${permitExpiresAt}T23:59:59Z`);
  return !Number.isNaN(expiry.getTime()) && expiry.getTime() < today.getTime();
}

// ---------------------------------------------------------------------------
// Rules

function workAuthorization(c: CandidateEligibility, j: JobEligibilityFacts, today: Date): RuleResult {
  const rule: RuleId = 'work_authorization';
  const where = countryName(j.country);
  if (!j.workAuthorization) {
    return { rule, status: 'pass', reason: 'The posting states no work-authorisation requirement.', hard: true };
  }
  if (!MODELLED.has(j.country)) {
    return { rule, status: 'unknown', reason: `The posting requires authorisation to work in ${where}, a jurisdiction the engine does not model yet.`, hard: true };
  }
  const w = c.workAuth;
  if (!w || w.status === 'unspecified') {
    return { rule, status: 'unknown', reason: `The posting requires authorisation to work in ${where}; your work authorisation is not recorded. Add it under Settings › Work authorisation.`, hard: true };
  }
  if (w.country !== j.country) {
    return { rule, status: 'fail', reason: `The posting requires authorisation to work in ${where}; your recorded authorisation is for ${countryName(w.country)}. Record an authorisation for ${where} if you hold one.`, hard: true };
  }
  const citizenship = j.workAuthorization === 'citizenship_or_pr_required';
  switch (w.status) {
    case 'citizen':
    case 'permanent_resident':
      return { rule, status: 'pass', reason: `You are a ${w.status === 'citizen' ? 'citizen' : 'permanent resident'} of ${where}, which meets the posting's requirement.`, hard: true };
    case 'work_permit':
      if (citizenship) return { rule, status: 'fail', reason: `The posting requires citizenship or permanent residence in ${where}; you hold a work permit.`, hard: true };
      if (permitExpired(w.permitExpiresAt, today)) return { rule, status: 'fail', reason: `The posting requires authorisation to work in ${where}; your recorded work permit expired on ${w.permitExpiresAt}. Update it if it was renewed.`, hard: true };
      return { rule, status: 'pass', reason: `Your work permit for ${where} meets the posting's authorisation requirement${w.permitExpiresAt ? ` (valid to ${w.permitExpiresAt})` : ''}.`, hard: true };
    case 'study_permit':
      if (citizenship) return { rule, status: 'fail', reason: `The posting requires citizenship or permanent residence in ${where}; you hold a study permit.`, hard: true };
      return { rule, status: 'unknown', reason: `The posting requires authorisation to work in ${where}; a study permit allows limited work, so confirm the hours and terms before applying.`, hard: true };
    case 'requires_sponsorship':
      return { rule, status: 'fail', reason: `The posting requires existing authorisation to work in ${where}; your profile says you need sponsorship to work there.`, hard: true };
    default:
      return { rule, status: 'unknown', reason: `The posting requires authorisation to work in ${where}; your recorded status ("${w.status}") does not say whether you hold it.`, hard: true };
  }
}

function sponsorship(c: CandidateEligibility, j: JobEligibilityFacts): RuleResult {
  const rule: RuleId = 'sponsorship';
  if (!needsSponsorship(c)) {
    return { rule, status: 'pass', reason: c.workAuth ? 'You do not need sponsorship.' : 'Your profile does not say you need sponsorship.', hard: true };
  }
  if (j.sponsorship === 'not_offered') return { rule, status: 'fail', reason: 'You need sponsorship and the posting says it is not offered.', hard: true };
  if (j.sponsorship === 'offered') return { rule, status: 'pass', reason: 'You need sponsorship and the posting says it is offered.', hard: true };
  return { rule, status: 'unknown', reason: 'You need sponsorship and the posting does not say whether it is offered. Ask before investing in an application.', hard: true };
}

function securityClearance(j: JobEligibilityFacts): RuleResult {
  const rule: RuleId = 'security_clearance';
  if (j.workAuthorization !== 'security_clearance_required') return { rule, status: 'pass', reason: 'The posting states no clearance requirement.', hard: true };
  return { rule, status: 'unknown', reason: 'The posting requires a security clearance. Your profile does not record clearances yet, so this is for you to confirm.', hard: true };
}

function regionTokens(location: string, postalRegion: string | null): string[] {
  const out = new Set<string>();
  for (const part of location.toLowerCase().split(/[,;/|()–—-]+/)) {
    const t = part.replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
    if (t) out.add(t);
  }
  if (postalRegion && postalRegion !== 'remote') {
    const [region, city] = postalRegion.split('/');
    out.add(region.toLowerCase());
    out.add(region.split('-')[1]?.toLowerCase() ?? '');
    if (city) out.add(city.replace(/-/g, ' ').toLowerCase());
  }
  out.delete('');
  return [...out];
}

function location(c: CandidateEligibility, j: JobEligibilityFacts): RuleResult {
  const rule: RuleId = 'location';
  if (j.workMode === 'remote') return { rule, status: 'pass', reason: 'The role is remote.', hard: true };
  const p = c.preferences;
  if (!p || (p.countries.length === 0 && p.locations.length === 0)) {
    return { rule, status: 'pass', reason: 'You have not limited where you will work.', hard: true };
  }
  const relocates = p.relocation === 'open' || p.relocation === 'yes';
  if (p.countries.length > 0 && !p.countries.includes(j.country)) {
    if (relocates) return { rule, status: 'pass', reason: `The role is in ${countryName(j.country)}, outside the countries you listed, but you are open to relocating.`, hard: true };
    return { rule, status: 'fail', reason: `The role is in ${countryName(j.country)}, outside the countries you will work in (${p.countries.map(countryName).join(', ')}), and you are not open to relocating.`, hard: true };
  }
  if (p.locations.length === 0) return { rule, status: 'pass', reason: `The role is in ${countryName(j.country)}, a country you will work in.`, hard: true };
  if (!j.postalRegion) {
    return { rule, status: 'unknown', reason: `The posting's location ("${j.location}") could not be placed against the places you listed.`, hard: true };
  }
  const wanted = p.locations.map((x) => x.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const tokens = regionTokens(j.location, j.postalRegion);
  const matched = wanted.some((w) => tokens.some((t) => t === w || t.includes(w) || w.includes(t)));
  if (matched) return { rule, status: 'pass', reason: `${j.location} is among the places you will work.`, hard: true };
  if (relocates) return { rule, status: 'pass', reason: `${j.location} is not among the places you listed, but you are open to relocating.`, hard: true };
  return { rule, status: 'fail', reason: `${j.location} is not among the places you will work (${p.locations.join(', ')}) and you are not open to relocating.`, hard: true };
}

/**
 * Regulated designations the title itself can demand. When the title names
 * the profession and the posting lists the designation, missing it is a
 * hard fail; otherwise a listed certification is advisory, because the
 * extraction does not yet separate "required" from "a plus".
 */
const LICENSED: { designation: string; titleWords: RegExp; label: string }[] = [
  { designation: 'rn', titleWords: /\b(registered nurse|nurse|rn)\b/, label: 'Registered Nurse (RN) licence' },
  { designation: 'lpn', titleWords: /\b(licensed practical nurse|practical nurse|lpn)\b/, label: 'Licensed Practical Nurse (LPN) licence' },
  { designation: 'p eng', titleWords: /\b(professional engineer|p\.? ?eng)\b/, label: 'P.Eng. designation' },
  { designation: 'peng', titleWords: /\b(professional engineer|p\.? ?eng)\b/, label: 'P.Eng. designation' },
  { designation: 'cpa', titleWords: /\b(cpa|chartered professional accountant)\b/, label: 'CPA designation' },
];

function norm(x: string): string {
  return x.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function licensure(c: CandidateEligibility, j: JobEligibilityFacts): RuleResult {
  const rule: RuleId = 'licensure';
  const listed = j.certificationRequirements.map(norm).filter(Boolean);
  if (listed.length === 0) return { rule, status: 'pass', reason: 'The posting lists no licence or certification.', hard: false };
  const held = new Set(c.certifications.map(norm));
  const holds = (d: string) => [...held].some((h) => h === d || h.includes(d) || (d.length > 3 && d.includes(h)));
  const title = norm(j.title);
  const missingHard: string[] = [];
  const missingAdvisory: string[] = [];
  for (const d of listed) {
    if (holds(d)) continue;
    const licence = LICENSED.find((l) => l.designation === d);
    if (licence && licence.titleWords.test(title)) missingHard.push(licence.label);
    else missingAdvisory.push(d);
  }
  if (missingHard.length > 0) {
    return { rule, status: 'fail', reason: `The role is for a licensed profession and requires the ${missingHard.join(' and ')}, which your profile does not list. Add it under Certifications if you hold it.`, hard: true };
  }
  if (missingAdvisory.length > 0) {
    return { rule, status: 'unknown', reason: `The posting mentions ${missingAdvisory.join(', ')}, which your profile does not list. The posting may prefer rather than require it; check before applying.`, hard: false };
  }
  return { rule, status: 'pass', reason: 'You hold every licence or certification the posting mentions.', hard: false };
}

const BILINGUAL_LANGUAGES: Record<string, string[]> = { CA: ['english', 'french'], US: ['english', 'spanish'] };
const CANONICAL_LANGUAGE: Record<string, string> = { en: 'english', fr: 'french', es: 'spanish', zh: 'mandarin', de: 'german', pt: 'portuguese', it: 'italian', ja: 'japanese', ko: 'korean', hi: 'hindi', ar: 'arabic', ru: 'russian', pa: 'punjabi', tl: 'tagalog', vi: 'vietnamese', français: 'french' };

function language(c: CandidateEligibility, j: JobEligibilityFacts): RuleResult {
  const rule: RuleId = 'language';
  const wanted = new Set<string>();
  for (const l of j.languageRequirements.map((x) => x.toLowerCase())) {
    if (l === 'bilingual') for (const b of BILINGUAL_LANGUAGES[j.country] ?? []) wanted.add(b);
    else wanted.add(CANONICAL_LANGUAGE[l] ?? l);
  }
  if (wanted.size === 0) return { rule, status: 'pass', reason: 'The posting states no language requirement.', hard: false };
  const spoken = new Set(c.languages.filter((l) => l.proficiency !== 'basic').map((l) => CANONICAL_LANGUAGE[l.language.toLowerCase()] ?? l.language.toLowerCase()));
  const missing = [...wanted].filter((w) => !spoken.has(w));
  if (missing.length === 0) return { rule, status: 'pass', reason: `Your profile lists ${[...wanted].join(' and ')} at a working level.`, hard: false };
  return { rule, status: 'unknown', reason: `The posting mentions ${missing.join(' and ')}, which your profile does not list at a working level. It may be preferred rather than required; check before applying.`, hard: false };
}

// ---------------------------------------------------------------------------

/** Evaluate every rule. Pure; `today` is injectable for permit expiry. */
export function evaluateEligibility(candidate: CandidateEligibility, job: JobEligibilityFacts, today = new Date()): EligibilityVerdict {
  const rules: RuleResult[] = [
    workAuthorization(candidate, job, today),
    sponsorship(candidate, job),
    securityClearance(job),
    location(candidate, job),
    licensure(candidate, job),
    language(candidate, job),
  ];
  const outcome: Outcome = rules.some((r) => r.status === 'fail' && r.hard) ? 'ineligible' : rules.some((r) => r.status === 'unknown') ? 'unknown' : 'eligible';
  return { outcome, rules, rulesVersion: RULES_VERSION };
}

/** The reasons a candidate is excluded, for display; empty when not ineligible. */
export function exclusionReasons(verdict: EligibilityVerdict): string[] {
  return verdict.rules.filter((r) => r.status === 'fail' && r.hard).map((r) => r.reason);
}
