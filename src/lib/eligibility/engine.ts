/**
 * Stage 07 — the eligibility engine (JOB_INTELLIGENCE_ARCHITECTURE
 * "Eligibility engine (Stage 07) — distinct from scoring").
 *
 * Hard pass / fail gates, evaluated BEFORE and apart from fit. Pure and
 * deterministic: the same candidate facts and job facts always yield the
 * same verdict, and every rule states its reason in words a candidate can
 * act on. There is no score anywhere in the output — a reason may quote a
 * date the candidate recorded, never a percentage or a rank.
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

export const RULES_VERSION = '2026-09-05.1';

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
    relocation: string; // no | open | yes
  } | null;
  certifications: string[];
  languages: { language: string; proficiency: string }[];
}

/** What the engine reads from the canonical job (Stage 06). */
export interface JobEligibilityFacts {
  title: string;
  /** Stage 06 normalised title (qualifiers and requisition ids removed). */
  normalizedTitle: string;
  /**
   * False for a Job row the canonical pipeline has not read yet
   * (`canonicalHash` empty): every posting-side rule answers `unknown`
   * rather than claiming the posting "states nothing".
   */
  read: boolean;
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
  if (!j.read) {
    return { rule, status: 'unknown', reason: 'This posting has not been read for eligibility statements yet; it will be on the next scan.', hard: true };
  }
  if (!j.workAuthorization) {
    return { rule, status: 'pass', reason: 'The posting states no work-authorisation requirement.', hard: true };
  }
  if (j.workAuthorization === 'security_clearance_required') {
    // The canonical field holds ONE statement, the strongest; a clearance
    // requirement may have stood alongside a citizenship one the extraction
    // could not keep. The clearance rule carries it; this rule does not
    // invent an authorisation statement the posting may not have made.
    return { rule, status: 'unknown', reason: `The posting requires a security clearance, which usually implies the right to work in ${where}; it did not state a separate authorisation requirement the engine could check.`, hard: true };
  }
  if (!MODELLED.has(j.country)) {
    return { rule, status: 'unknown', reason: `The posting requires authorisation to work in ${where}, a jurisdiction the engine does not model yet.`, hard: true };
  }
  const w = c.workAuth;
  if (!w || w.status === 'unspecified') {
    return { rule, status: 'unknown', reason: `The posting requires authorisation to work in ${where}; your work authorisation is not recorded. Add it under Settings › Work authorisation.`, hard: true };
  }
  if (w.country !== j.country) {
    // A recorded fact about another country is not a recorded fact about
    // this one: the profile holds one authorisation row, so a dual-authorised
    // candidate could not say otherwise. Open question, not an exclusion.
    return { rule, status: 'unknown', reason: `The posting requires authorisation to work in ${where}; your recorded authorisation is for ${countryName(w.country)}, so the engine cannot tell. Record your ${where} authorisation if you hold one.`, hard: true };
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
  if (!j.read && needsSponsorship(c)) {
    return { rule, status: 'unknown', reason: 'You need sponsorship and this posting has not been read for eligibility statements yet.', hard: true };
  }
  if (!needsSponsorship(c)) {
    return { rule, status: 'pass', reason: c.workAuth ? 'You do not need sponsorship.' : 'Your profile does not say you need sponsorship.', hard: true };
  }
  if (j.sponsorship === 'not_offered') return { rule, status: 'fail', reason: 'You need sponsorship and the posting says it is not offered.', hard: true };
  if (j.sponsorship === 'offered') return { rule, status: 'pass', reason: 'You need sponsorship and the posting says it is offered.', hard: true };
  return { rule, status: 'unknown', reason: 'You need sponsorship and the posting does not say whether it is offered. Ask before investing in an application.', hard: true };
}

function securityClearance(j: JobEligibilityFacts): RuleResult {
  const rule: RuleId = 'security_clearance';
  if (!j.read) return { rule, status: 'unknown', reason: 'This posting has not been read for eligibility statements yet.', hard: true };
  if (j.workAuthorization !== 'security_clearance_required') return { rule, status: 'pass', reason: 'The posting states no clearance requirement.', hard: true };
  return { rule, status: 'unknown', reason: 'The posting requires a security clearance. Your profile does not record clearances yet, so this is for you to confirm.', hard: true };
}

const WORK_MODE_WORDS = new Set(['remote', 'hybrid', 'onsite', 'on site', 'on-site', 'in office', 'anywhere', 'wfh', 'work from home']);
const PROVINCE_NAMES: Record<string, string> = {
  ab: 'alberta', bc: 'british columbia', mb: 'manitoba', nb: 'new brunswick', nl: 'newfoundland and labrador', ns: 'nova scotia', nt: 'northwest territories', nu: 'nunavut', on: 'ontario', pe: 'prince edward island', qc: 'quebec', sk: 'saskatchewan', yt: 'yukon',
};

function normPlace(x: string): string {
  return x.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** The posting's place as WHOLE names: city, province code, province name, country. Never a substring. */
function jobPlaces(j: JobEligibilityFacts): { city: string | null; region: string | null; names: Set<string> } {
  const names = new Set<string>();
  let city: string | null = null;
  let region: string | null = null;
  if (j.postalRegion && j.postalRegion !== 'remote') {
    const [regionPart, cityPart] = j.postalRegion.split('/');
    const code = regionPart.split('-')[1]?.toLowerCase() ?? '';
    region = code || null;
    if (code) {
      names.add(code);
      if (PROVINCE_NAMES[code]) names.add(PROVINCE_NAMES[code]);
    }
    if (cityPart) {
      city = cityPart.replace(/-/g, ' ').toLowerCase();
      names.add(city);
    }
  }
  names.add(countryName(j.country).toLowerCase());
  names.add(j.country.toLowerCase());
  for (const part of j.location.split(/[,;/|()]+/)) {
    const t = normPlace(part);
    if (t) names.add(t);
  }
  return { city, region, names };
}

function location(c: CandidateEligibility, j: JobEligibilityFacts): RuleResult {
  const rule: RuleId = 'location';
  if (j.workMode === 'remote') return { rule, status: 'pass', reason: 'The role is remote.', hard: true };
  const p = c.preferences;
  const wanted = (p?.locations ?? []).map(normPlace).filter((x) => x && !WORK_MODE_WORDS.has(x));
  if (!p || (p.countries.length === 0 && wanted.length === 0)) {
    return { rule, status: 'pass', reason: 'You have not limited where you will work.', hard: true };
  }
  const relocates = p.relocation === 'open' || p.relocation === 'yes';
  if (p.countries.length > 0 && !p.countries.includes(j.country)) {
    if (relocates) return { rule, status: 'pass', reason: `The role is in ${countryName(j.country)}, outside the countries you listed, but you are open to relocating.`, hard: true };
    return { rule, status: 'fail', reason: `The role is in ${countryName(j.country)}, outside the countries you will work in (${p.countries.map(countryName).join(', ')}), and you are not open to relocating.`, hard: true };
  }
  if (wanted.length === 0) return { rule, status: 'pass', reason: `The role is in ${countryName(j.country)}, a country you will work in.`, hard: true };
  if (!j.postalRegion) {
    return { rule, status: 'unknown', reason: `The posting's location ("${j.location}") could not be placed against the places you listed.`, hard: true };
  }
  const places = jobPlaces(j);
  // A whole name only: "Toronto" matches Toronto, "Ontario" or "ON" matches
  // every Ontario posting; "on" inside "London" matches nothing.
  if (wanted.some((w) => places.names.has(w))) return { rule, status: 'pass', reason: `${j.location} is among the places you will work.`, hard: true };
  if (relocates) return { rule, status: 'pass', reason: `${j.location} is not among the places you listed, but you are open to relocating.`, hard: true };
  // Same province, different municipality: there is no radius yet, so a
  // suburb of a listed city cannot be told from a city across the province.
  // An open question, not an exclusion.
  const wantedInRegion = wanted.some((w) => (places.region && PROVINCE_NAMES[places.region] === w) || w === places.region);
  if (!wantedInRegion && places.region && wanted.some((w) => KNOWN_CITY_REGION[w] === places.region)) {
    return { rule, status: 'unknown', reason: `${j.location} is in the same province as a place you listed (${p.locations.join(', ')}) but not the same municipality; the engine has no distance rule yet, so check the commute.`, hard: true };
  }
  return { rule, status: 'fail', reason: `${j.location} is not among the places you will work (${p.locations.join(', ')}) and you are not open to relocating.`, hard: true };
}

/** Enough of the country's cities to place a listed city in its province; a city not here yields a plain fail, never a guess. */
const KNOWN_CITY_REGION: Record<string, string> = {
  toronto: 'on', ottawa: 'on', mississauga: 'on', brampton: 'on', hamilton: 'on', london: 'on', markham: 'on', vaughan: 'on', kitchener: 'on', waterloo: 'on', windsor: 'on', oakville: 'on', burlington: 'on', 'thunder bay': 'on', sudbury: 'on', kingston: 'on', guelph: 'on', barrie: 'on', oshawa: 'on',
  montreal: 'qc', laval: 'qc', gatineau: 'qc', longueuil: 'qc', 'quebec city': 'qc', sherbrooke: 'qc', 'trois rivieres': 'qc',
  vancouver: 'bc', burnaby: 'bc', surrey: 'bc', richmond: 'bc', victoria: 'bc', kelowna: 'bc', coquitlam: 'bc', langley: 'bc', nanaimo: 'bc',
  calgary: 'ab', edmonton: 'ab', 'red deer': 'ab', lethbridge: 'ab',
  winnipeg: 'mb', regina: 'sk', saskatoon: 'sk', halifax: 'ns', moncton: 'nb', fredericton: 'nb', 'saint john': 'nb', "st john's": 'nl', charlottetown: 'pe',
};

/**
 * Regulated designations the title itself can demand. A designation matches
 * by any of its spellings, on WHOLE words ("Registered Nurse (CNO)" holds
 * `rn`; "Certified Internal Auditor" does not). When the normalised title
 * names the profession and the posting lists the designation, missing it is
 * a hard fail; a title that merely prefers it ("CPA preferred") is not a
 * demand; otherwise a listed certification is advisory, because the
 * extraction does not yet separate "required" from "a plus".
 */
const LICENSED: { designation: string; spellings: string[]; titleWords: RegExp; label: string }[] = [
  { designation: 'rn', spellings: ['rn', 'registered nurse'], titleWords: /\b(registered nurse|rn)\b/, label: 'Registered Nurse (RN) licence' },
  { designation: 'lpn', spellings: ['lpn', 'licensed practical nurse', 'rpn', 'registered practical nurse'], titleWords: /\b(licensed practical nurse|registered practical nurse|lpn|rpn)\b/, label: 'Licensed Practical Nurse (LPN) licence' },
  { designation: 'p eng', spellings: ['p eng', 'peng', 'professional engineer'], titleWords: /\b(professional engineer|p eng|peng)\b/, label: 'P.Eng. designation' },
  { designation: 'peng', spellings: ['p eng', 'peng', 'professional engineer'], titleWords: /\b(professional engineer|p eng|peng)\b/, label: 'P.Eng. designation' },
  { designation: 'cpa', spellings: ['cpa', 'chartered professional accountant'], titleWords: /\b(cpa|chartered professional accountant)\b/, label: 'CPA designation' },
];
const PREFERRED_WORDING = /\b(preferred|an? asset|a plus|nice to have|desirable|welcome)\b/;
/** Words that mean a recorded certification is not yet held. Kept identical to src/lib/career/engine.ts NOT_YET_HELD (a test compares them). */
export const NOT_YET_HELD = /\b(in progress|in-progress|candidate|student|pursuing|towards|toward|exam|prep|course|enrolled|studying|expected)\b/;

function norm(x: string): string {
  return x.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function hasWholeWords(haystack: string, needle: string): boolean {
  return needle.length > 0 && new RegExp(`(^|\\s)${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(haystack);
}

function licensure(c: CandidateEligibility, j: JobEligibilityFacts): RuleResult {
  const rule: RuleId = 'licensure';
  if (!j.read) return { rule, status: 'unknown', reason: 'This posting has not been read for eligibility statements yet.', hard: false };
  const listed = [...new Set(j.certificationRequirements.map(norm).filter(Boolean))];
  if (listed.length === 0) return { rule, status: 'pass', reason: 'The posting lists no licence or certification.', hard: false };
  // A certification recorded as not yet held - "CPA (in progress)", "P.Eng candidate" - does not
  // satisfy a licence the posting requires (Stage 16 review, shared vocabulary with the career engine).
  const held = c.certifications.map(norm).filter((h) => h && !NOT_YET_HELD.test(h));
  const holds = (spellings: string[]) => held.some((h) => spellings.some((sp) => hasWholeWords(h, sp)));
  const title = norm(j.normalizedTitle || j.title);
  const rawTitle = norm(j.title);
  const missingHard = new Set<string>();
  const missingAdvisory: string[] = [];
  for (const d of listed) {
    const licence = LICENSED.find((l) => l.designation === d);
    if (licence) {
      if (holds(licence.spellings)) continue;
      if (licence.titleWords.test(title) && !PREFERRED_WORDING.test(rawTitle)) missingHard.add(licence.label);
      else missingAdvisory.push(d);
      continue;
    }
    if (holds([d])) continue;
    missingAdvisory.push(d);
  }
  if (missingHard.size > 0) {
    return { rule, status: 'fail', reason: `The role is for a licensed profession and requires the ${[...missingHard].join(' and ')}, which your profile does not list. Add it under Certifications if you hold it.`, hard: true };
  }
  if (missingAdvisory.length > 0) {
    return { rule, status: 'unknown', reason: `The posting mentions ${missingAdvisory.join(', ')}, which your profile does not list. The posting may prefer rather than require it; check before applying.`, hard: false };
  }
  return { rule, status: 'pass', reason: 'You hold every licence or certification the posting mentions.', hard: false };
}

const BILINGUAL_LANGUAGES: Record<string, string[]> = { CA: ['english', 'french'], US: ['english', 'spanish'] };
const CANONICAL_LANGUAGE: Record<string, string> = { en: 'english', fr: 'french', es: 'spanish', zh: 'mandarin', de: 'german', pt: 'portuguese', it: 'italian', ja: 'japanese', ko: 'korean', hi: 'hindi', ar: 'arabic', ru: 'russian', pa: 'punjabi', tl: 'tagalog', vi: 'vietnamese', 'français': 'french', francais: 'french' };

function canonicalLanguage(x: string): string {
  const base = x.toLowerCase().replace(/\(.*?\)/g, '').trim().split(/[-_]/)[0].trim();
  return CANONICAL_LANGUAGE[base] ?? base;
}

function language(c: CandidateEligibility, j: JobEligibilityFacts): RuleResult {
  const rule: RuleId = 'language';
  if (!j.read) return { rule, status: 'unknown', reason: 'This posting has not been read for eligibility statements yet.', hard: false };
  const wanted = new Set<string>();
  for (const l of j.languageRequirements.map((x) => x.toLowerCase())) {
    if (l === 'bilingual') for (const b of BILINGUAL_LANGUAGES[j.country] ?? []) wanted.add(b);
    else wanted.add(CANONICAL_LANGUAGE[l] ?? l);
  }
  if (wanted.size === 0) return { rule, status: 'pass', reason: 'The posting states no language requirement.', hard: false };
  const spoken = new Set(c.languages.filter((l) => l.proficiency !== 'basic').map((l) => canonicalLanguage(l.language)));
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
