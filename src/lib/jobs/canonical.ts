import { createHash } from 'node:crypto';
import { extractSkills, isVocabularySkill, normalize } from '@/lib/providers/ai/keywords';
import type { NormalizedPosting } from '@/lib/connectors/types';

/**
 * Stage 06 — the canonical job (JOB_INTELLIGENCE_ARCHITECTURE "Canonical job").
 *
 * Everything here is PURE and DETERMINISTIC: the same capture always yields
 * the same canonical fields and the same `canonicalHash`, which is what
 * lets two sources carrying one posting collapse into one Job with two
 * provenance rows. Nothing is inferred beyond what the text states:
 * sponsorship is `unknown` unless the posting says otherwise, experience is
 * a range only when a number of years is written, and a requirement is
 * "preferred" only when the posting marks it so.
 *
 * The extraction is lexical (regular expressions and the closed skill
 * vocabulary). It is measured, not assumed: `tests/canonical-jobs.test.ts`
 * checks every field against golden fixtures and reports dedup precision /
 * recall on a labelled pair set. Its limits are recorded there and in the
 * evidence document, never papered over.
 */

export interface CanonicalFields {
  normalizedTitle: string;
  normalizedCompany: string;
  postalRegion: string | null;
  canonicalHash: string;
  requiredSkills: string[];
  preferredSkills: string[];
  educationRequirements: string[];
  certificationRequirements: string[];
  experienceYearsMin: number | null;
  experienceYearsMax: number | null;
  languageRequirements: string[];
  workAuthorization: WorkAuthorizationStatement | null;
  sponsorship: Sponsorship;
}

export type Sponsorship = 'unknown' | 'offered' | 'not_offered';
export type WorkAuthorizationStatement = 'authorization_required' | 'citizenship_or_pr_required' | 'security_clearance_required';

// ---------------------------------------------------------------------------
// Title

// A requisition id is any token carrying a digit after a "req / job id / ref /
// #" marker: numeric ("4521"), prefixed ("R-2024-1234"), or alphanumeric
// ("JR0012345", "3f9a1b2c") — real systems use all three.
const REQUISITION = /\b(?:req(?:uisition)?|job|posting|position|ref(?:erence)?)\s*(?:id|no|number|code)?\s*[#:.]?\s*(?=[a-z0-9_-]*\d)[a-z0-9_-]+\b|#\s*(?=[a-z0-9_-]*\d)[a-z0-9_-]+\b/gi;
const TITLE_NOISE_SEGMENT = /^(remote|hybrid|on[- ]?site|in[- ]office|work from home|wfh|contract|permanent|full[- ]time|part[- ]time|temporary|internship|co-op|urgent(ly)? hiring|immediate start|new|hiring now)$/;

/**
 * The title as a candidate reads it, lower-cased, without bracketed
 * qualifiers, requisition numbers, or trailing segments that name a work
 * mode, an employment type, a place or the employer. Seniority is KEPT —
 * "senior data analyst" and "data analyst" are different jobs — which is
 * why this is not the taxonomy's `normalizeTitle` (that one strips
 * qualifiers to find the occupation).
 */
const TITLE_ABBREVIATIONS: Record<string, string> = { sr: 'senior', jr: 'junior', mgr: 'manager', assoc: 'associate', asst: 'assistant', eng: 'engineer', dev: 'developer', admin: 'administrator', coord: 'coordinator', spec: 'specialist', rep: 'representative' };
const TITLE_LEADING_LABEL = /^(?:position|job title|title|role|posting)\s*:\s*/;

export function normalizeJobTitle(title: string, company = '', location = ''): string {
  const lower = title
    .toLowerCase()
    .replace(TITLE_LEADING_LABEL, '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(REQUISITION, ' ')
    // "Sr. Developer" and "Senior Developer" are one title.
    .replace(/\b([a-z]+)\.?(?=[^a-z0-9]|$)/g, (m, w: string) => TITLE_ABBREVIATIONS[w] ?? m);
  const segments = lower.split(/\s+[-–—|]\s+|\s*[|]\s*|\s*:\s+/).map((seg) => seg.replace(/[^\p{L}\p{N}+#.]+/gu, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const companyNorm = normalizeCompany(company);
  const locationWords = location.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const kept = segments.filter((seg, i) => {
    if (i === 0) return true;
    if (TITLE_NOISE_SEGMENT.test(seg)) return false;
    if (companyNorm && (seg === companyNorm || normalizeCompany(seg) === companyNorm)) return false;
    if (locationWords && (locationWords.includes(seg) || seg.split(' ').every((w) => CA_PROVINCES[w] || US_STATES[w] || CITY_HINTS[w] || COUNTRY_WORDS.has(w) || locationWords.includes(w)))) return false;
    return true;
  });
  const joined = (kept.length ? kept : segments).join(' ').replace(/\s+/g, ' ').trim();
  return joined.replace(/\.$/, '');
}

// ---------------------------------------------------------------------------
// Company

// Legal forms at the TAIL only ("Maple Analytics Inc.", "Acme Corp"), never a
// word inside the name: "Canada Life" and "Air Canada" are the names.
const TRAILING_LEGAL_FORM = /(?:\s+(?:inc|incorporated|ltd|limited|llc|corp|corporation|co|company|plc|gmbh|sa|ag))+$/;

/** Lower-cased, punctuation-free, leading article and trailing legal forms removed. */
export function normalizeCompany(company: string): string {
  const base = company.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const stripped = base.replace(/^the\s+/, '').replace(TRAILING_LEGAL_FORM, '').trim();
  return stripped || base;
}

// ---------------------------------------------------------------------------
// Region

const CA_PROVINCES: Record<string, string> = {
  ab: 'AB', alberta: 'AB', bc: 'BC', 'british columbia': 'BC', mb: 'MB', manitoba: 'MB', nb: 'NB', 'new brunswick': 'NB',
  nl: 'NL', 'newfoundland and labrador': 'NL', newfoundland: 'NL', ns: 'NS', 'nova scotia': 'NS', nt: 'NT', 'northwest territories': 'NT',
  nu: 'NU', nunavut: 'NU', on: 'ON', ontario: 'ON', pe: 'PE', pei: 'PE', 'prince edward island': 'PE', qc: 'QC', quebec: 'QC', 'québec': 'QC',
  sk: 'SK', saskatchewan: 'SK', yt: 'YT', yukon: 'YT',
};

const US_STATE_LIST =
  'AL alabama,AK alaska,AZ arizona,AR arkansas,CA california,CO colorado,CT connecticut,DE delaware,FL florida,GA georgia,HI hawaii,ID idaho,IL illinois,IN indiana,IA iowa,KS kansas,KY kentucky,LA louisiana,ME maine,MD maryland,MA massachusetts,MI michigan,MN minnesota,MS mississippi,MO missouri,MT montana,NE nebraska,NV nevada,NH new hampshire,NJ new jersey,NM new mexico,NY new york,NC north carolina,ND north dakota,OH ohio,OK oklahoma,OR oregon,PA pennsylvania,RI rhode island,SC south carolina,SD south dakota,TN tennessee,TX texas,UT utah,VT vermont,VA virginia,WA washington,WV west virginia,WI wisconsin,WY wyoming,DC district of columbia';
const US_STATES: Record<string, string> = Object.fromEntries(
  US_STATE_LIST.split(',').flatMap((entry) => {
    const [code, ...name] = entry.split(' ');
    return [
      [code.toLowerCase(), code],
      [name.join(' '), code],
    ];
  }),
);

const CITY_HINTS: Record<string, string> = {
  toronto: 'CA-ON', ottawa: 'CA-ON', mississauga: 'CA-ON', waterloo: 'CA-ON', kitchener: 'CA-ON', hamilton: 'CA-ON', london: 'CA-ON', markham: 'CA-ON', brampton: 'CA-ON',
  vancouver: 'CA-BC', burnaby: 'CA-BC', victoria: 'CA-BC', surrey: 'CA-BC', kelowna: 'CA-BC', richmond: 'CA-BC',
  calgary: 'CA-AB', edmonton: 'CA-AB', winnipeg: 'CA-MB', regina: 'CA-SK', saskatoon: 'CA-SK', halifax: 'CA-NS',
  montreal: 'CA-QC', 'montréal': 'CA-QC', 'quebec city': 'CA-QC', laval: 'CA-QC', gatineau: 'CA-QC', moncton: 'CA-NB', 'st john s': 'CA-NL',
};

const COUNTRY_WORDS = new Set(['canada', 'usa', 'united states', 'us', 'u s', 'u s a']);
const REMOTE = /^(fully |100% )?remote\b/;
const REMOTE_TRAILING = /\b(remote|work from home|wfh)\s*(?:[-–—,(]\s*)?(canada|usa|us|anywhere|north america)?\)?$/;
const POSTAL = /\b\d{5}(?:-\d{4})?\b|\b[a-z]\d[a-z]\s?\d[a-z]\d\b/g;

/**
 * "Toronto, ON" → "CA-ON/toronto"; "Austin, TX 78701" → "US-TX/austin";
 * "Remote" / "Remote - Canada" → "remote"; unparseable → null. The
 * region comes from the posting's own country table; a city alone counts
 * only when it is on the known-city list for that country.
 */
export function postalRegion(location: string, country: 'CA' | 'US', workMode?: string): string | null {
  const raw = location
    .toLowerCase()
    .replace(/\s+/g, ' ')
    // "Hybrid - Toronto, ON": the work mode is not the place.
    .replace(/^(hybrid|on[- ]?site|in[- ]office)\s*(?:[-–—,|:]\s*)?/, '')
    .trim();
  if (!raw) return workMode === 'remote' ? 'remote' : null;
  if (REMOTE.test(raw) || REMOTE_TRAILING.test(raw)) return 'remote';
  const parts = raw
    .replace(/\(.*?\)/g, ' ')
    .split(/\s*[,;/·|]\s*|\s+[-–—]\s+/)
    .map((p) => p.replace(POSTAL, '').replace(/\./g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const table = country === 'CA' ? CA_PROVINCES : US_STATES;
  // The region is the LAST part that names a province or state ("New York,
  // NY" names the state twice; the city is the earlier one), the city the
  // first remaining part that is not a country word.
  let regionIndex = -1;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (table[parts[i]]) {
      regionIndex = i;
      break;
    }
  }
  let region: string | null = regionIndex >= 0 ? `${country}-${table[parts[regionIndex]]}` : null;
  const city = parts.find((p, i) => i !== regionIndex && !COUNTRY_WORDS.has(p)) ?? null;
  if (!region && city && CITY_HINTS[city]?.startsWith(country)) region = CITY_HINTS[city];
  if (!region) return null;
  const citySlug = city ? city.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') : '';
  return citySlug ? `${region}/${citySlug}` : region;
}

// ---------------------------------------------------------------------------
// Requirements

const PREFERRED = /\b(preferred|nice[- ]to[- ]have|an? asset|bonus|a plus|is a plus|would be (a )?(plus|an asset)|desirable|ideally)\b/i;
const SECTION_PREFERRED = /^\s*(preferred|nice[- ]to[- ]have|bonus|desirable|assets?)\b/i;
const SECTION_REQUIRED = /^\s*(requirements?|qualifications?|required|must[- ]haves?|what you('ll| will) (need|bring)|about you|who you are)\b/i;
const SECTION_END = /^\s*(benefits|what we offer|about (us|the (company|team))|how to apply|compensation|perks|why (join|work))\b/i;

// Bare "BA" / "MA" are also a US state and a common word; they count only in
// a degree context ("BA in …", "BA or BS", "B.A.").
const DEGREE = /\b(ph\.?d|doctorate|master'?s?( degree)?|mba|bachelor'?s?( degree)?|b\.?sc|b\.a\.|m\.a\.|b\.?eng|m\.?sc|m\.?eng|(?:ba|bs|ma|ms)(?= (?:in|or|\/|degree)\b)|college diploma|diploma|associate'?s? degree|high school( diploma)?|post[- ]secondary|undergraduate degree|graduate degree)\b/gi;
const CERT = /\b(pmp|cpa|cfa|cissp|ccna|ccnp|cism|cisa|prince2|itil|six sigma|scrum master|csm|psm|cka|ckad|aws certified (?:solutions architect|developer|sysops administrator|devops engineer|cloud practitioner|security|data engineer|machine learning|data analytics)(?: ?[-–] ?(?:associate|professional|specialty))?|comptia [a-z+]+|rn|lpn|bls|acls|red seal|p\.?eng|cfp|frm|cbap|shrm-[cs]p|chrp|chrl|cphr)\b/gi;
const YEARS = /(?<!\d)(\d{1,2})(?!\d)\s*(?:\+|plus)?\s*(?:-|–|to)?\s*(?:(?<!\d)(\d{1,2})(?!\d))?\s*\+?\s*(?:years?|yrs?)\b/gi;
const LANGUAGES = /\b(english|french|français|bilingual(?:ism)?|spanish|mandarin|cantonese|punjabi|arabic|german|portuguese|italian|japanese|korean|hindi|tagalog|russian|vietnamese)\b/gi;

function splitSegments(p: NormalizedPosting): { text: string; preferred: boolean }[] {
  const out: { text: string; preferred: boolean }[] = [];
  let mode: 'required' | 'preferred' | 'other' = 'other';
  for (const line of p.description.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    // A heading switches the mode; what follows the colon on the same line
    // ("Requirements: SQL and Python.") is content in the new mode.
    const heading = t.match(/^([^:.]{1,40})(?::\s*(.*))?$/);
    const head = heading?.[1] ?? '';
    const rest = heading?.[2] ?? '';
    let switched = false;
    if (head && SECTION_PREFERRED.test(head) && (rest || t.length < 60)) { mode = 'preferred'; switched = true; }
    else if (head && SECTION_REQUIRED.test(head) && (rest || t.length < 60)) { mode = 'required'; switched = true; }
    else if (head && SECTION_END.test(head) && (rest || t.length < 60)) { mode = 'other'; switched = true; }
    if (switched && !rest) continue;
    const body = switched ? rest : t;
    for (const chunk of body.split(/(?<=[.;!?])\s+/)) {
      // A later inline heading in the same line ("Preferred: SQL. Requirements: Python.").
      const inline = chunk.match(/^([^:.]{1,40}):\s*(.*)$/);
      if (inline && SECTION_PREFERRED.test(inline[1])) mode = 'preferred';
      else if (inline && SECTION_REQUIRED.test(inline[1])) mode = 'required';
      else if (inline && SECTION_END.test(inline[1])) mode = 'other';
      const sentence = inline && (SECTION_PREFERRED.test(inline[1]) || SECTION_REQUIRED.test(inline[1]) || SECTION_END.test(inline[1])) ? inline[2] : chunk;
      const s = sentence.trim();
      if (!s) continue;
      out.push({ text: s, preferred: mode === 'preferred' || PREFERRED.test(s) });
    }
  }
  for (const r of p.requirements) out.push({ text: r, preferred: PREFERRED.test(r) });
  return out;
}

function unique(xs: string[]): string[] {
  return [...new Set(xs.map((x) => x.trim().toLowerCase()).filter(Boolean))].sort();
}

/** Required and preferred skills, separated by where and how the posting states them. */
export function splitSkills(p: NormalizedPosting): { required: string[]; preferred: string[] } {
  const required = new Set<string>();
  const preferred = new Set<string>();
  for (const seg of splitSegments(p)) {
    for (const skill of extractSkills(seg.text)) (seg.preferred ? preferred : required).add(skill);
  }
  // A skill the source listed counts as required unless the text marked it
  // preferred; a skill in both buckets is required.
  for (const s of p.skills.map((x) => normalize(x))) if (!preferred.has(s)) required.add(s);
  for (const s of required) preferred.delete(s);
  return { required: [...required].sort(), preferred: [...preferred].sort() };
}

export function educationRequirements(text: string): string[] {
  return unique([...text.matchAll(DEGREE)].map((m) => m[0].replace(/\s+/g, ' ').replace(/[.']/g, '')));
}

export function certificationRequirements(text: string): string[] {
  return unique([...text.matchAll(CERT)].map((m) => m[0].replace(/\s+/g, ' ')));
}

/** The smallest stated minimum and the largest stated maximum; null when no years are written. */
export function experienceYears(text: string): { min: number | null; max: number | null } {
  let min: number | null = null;
  let max: number | null = null;
  for (const m of text.matchAll(YEARS)) {
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : null;
    if (!Number.isFinite(a) || a > 40) continue;
    min = min === null ? a : Math.min(min, a);
    if (b !== null && b >= a && b <= 40) max = max === null ? b : Math.max(max, b);
  }
  return { min, max };
}

export function languageRequirements(text: string): string[] {
  return unique(
    [...text.matchAll(LANGUAGES)].map((m) =>
      m[0]
        .toLowerCase()
        .replace('français', 'french')
        .replace(/^bilingual.*/, 'bilingual'),
    ),
  );
}

const NEGATED = /\b(not|no|never|without|isn't|aren't|won't|don't|doesn't)\b[^.;]{0,25}\b(required|necessary|needed|mandatory|a requirement)\b|\b(not|no)\s+(security |secret |reliability )?(clearance|citizenship|permanent residen\w+|work permit|authori[sz]ation)\b|\b(an? asset|preferred|nice[- ]to[- ]have|a plus|bonus)\b/;

function sentences(text: string): string[] {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .toLowerCase()
    .split(/(?<=[.;!?])\s+|\r?\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * What the posting STATES about the right to work; null when it says
 * nothing. Evaluated sentence by sentence, and a sentence that negates or
 * merely prefers the requirement ("not required", "an asset") never counts:
 * the false "required" is the dangerous direction — Stage 07 turns this into
 * an eligibility gate — so silence beats a guess. Canada and the US only.
 */
export function workAuthorization(text: string): WorkAuthorizationStatement | null {
  let found: WorkAuthorizationStatement | null = null;
  const rank: Record<WorkAuthorizationStatement, number> = { authorization_required: 1, citizenship_or_pr_required: 2, security_clearance_required: 3 };
  for (const t of sentences(text)) {
    if (NEGATED.test(t)) continue;
    let hit: WorkAuthorizationStatement | null = null;
    if (/\b(security|reliability|secret|top secret|enhanced) (clearance|status)\b/.test(t) || /\bclearance (is )?required\b/.test(t)) hit = 'security_clearance_required';
    else if (
      /\b(canadian citizen|citizenship|permanent resident|green card|u\.?s\.? citizen)s?\b[^.]{0,40}\b(required|only|must)\b/.test(t) ||
      /\b(must|only)\b[^.]{0,40}\b(canadian citizen|permanent resident|u\.?s\.? citizen|green card)/.test(t)
    ) hit = 'citizenship_or_pr_required';
    else if (
      /\b(legally |lawfully )?(authori[sz]ed|eligible|entitled|permitted) to work (in|within) (canada|the (us|u\.s\.|united states)|usa|the united states of america)\b/.test(t) ||
      /\bwork (permit|authori[sz]ation) (is )?required\b/.test(t) ||
      /\bmust (be|have)\b[^.]{0,30}(right|authori[sz]ation|eligib\w+) to work (in|within) (canada|the (us|u\.s\.|united states)|usa)\b/.test(t)
    ) hit = 'authorization_required';
    if (hit && (!found || rank[hit] > rank[found])) found = hit;
  }
  return found;
}

/** Only what is written, sentence by sentence: `unknown` is the honest default. */
export function sponsorship(text: string): Sponsorship {
  let result: Sponsorship = 'unknown';
  for (const t of sentences(text)) {
    if (!/sponsor/.test(t)) continue;
    const no =
      /\b(no|not|unable to|cannot|can't|will not|won't|does not|doesn't|do not|don't|never)\b[^.;]{0,40}\bsponsor/.test(t) ||
      /\bsponsorship (is )?(not |un)available\b/.test(t) ||
      /\bwithout (visa |immigration )?sponsorship\b/.test(t) ||
      /\bno (visa |immigration |work permit )?sponsorship\b/.test(t);
    const yes =
      /\b(visa |immigration |work permit |lmia )?sponsorship (is |may be |will be )?(available|offered|provided|possible)\b/.test(t) ||
      /\b(we|company|employer) (will|can|may|do) (offer|provide|consider|sponsor)\b/.test(t) ||
      /\bwilling to sponsor\b/.test(t) ||
      /\bwe sponsor\b/.test(t);
    if (no) return 'not_offered';
    if (yes) result = 'offered';
  }
  return result;
}

// ---------------------------------------------------------------------------
// Identity

/** The employer placeholder `normalizePosting` writes when a source omits it. */
export const UNDISCLOSED_EMPLOYER = normalizeCompany('Employer not disclosed');

export interface CanonicalIdentity {
  normalizedTitle: string;
  normalizedCompany: string;
  postalRegion: string | null;
  country: string;
  requiredSkills: string[];
  preferredSkills: string[];
}

/** The vocabulary part of the skill fingerprint: what survives an aggregator's reformatting. */
function skillFingerprint(fields: Pick<CanonicalIdentity, 'requiredSkills' | 'preferredSkills'>): string[] {
  return [...new Set([...fields.requiredSkills, ...fields.preferredSkills].filter((x) => isVocabularySkill(x)))].sort();
}

/**
 * Whether the identity is strong enough to merge on. A placeholder employer,
 * an unparseable region or an empty fingerprint would make every "Manager"
 * in Toronto one job; such a capture keeps its own identity instead (the
 * hash then includes the capture's source id, so it can only match itself).
 */
export function canonicalIdentityStrength(fields: CanonicalIdentity): 'strong' | 'weak' {
  if (!fields.normalizedTitle || !fields.normalizedCompany || fields.normalizedCompany === UNDISCLOSED_EMPLOYER) return 'weak';
  if (!fields.postalRegion) return 'weak';
  if (skillFingerprint(fields).length === 0) return 'weak';
  return 'strong';
}

/**
 * The canonical key: what a candidate would recognise as "the same job" —
 * the normalised title, the employer, the country and region, and the
 * posting's vocabulary skill fingerprint (the closed vocabulary makes it
 * stable across an aggregator's reformatting or truncation, where raw text
 * is not). Two postings that agree on all of them are one job with two
 * provenance rows. A weak identity (see `canonicalIdentityStrength`) is
 * salted with the capture's own id and never merges with anything.
 */
export function canonicalHash(fields: CanonicalIdentity, capture?: { source: string; externalId: string }): string {
  const parts = [fields.normalizedTitle, fields.normalizedCompany, fields.country, fields.postalRegion ?? '', skillFingerprint(fields).join(',')];
  if (canonicalIdentityStrength(fields) === 'weak') parts.push(`capture:${capture?.source ?? ''}:${capture?.externalId ?? ''}`);
  return createHash('sha256').update(parts.join(' ')).digest('hex');
}

/** Every canonical field for one normalised capture. Pure. */
export function canonicalize(p: NormalizedPosting): CanonicalFields {
  const text = `${p.title}\n${p.description}\n${p.requirements.join('\n')}`.replace(/[\u2018\u2019]/g, "'");
  const skills = splitSkills(p);
  const years = experienceYears(text);
  const fields = {
    normalizedTitle: normalizeJobTitle(p.title, p.company, p.location),
    normalizedCompany: normalizeCompany(p.company),
    postalRegion: postalRegion(p.location, p.country, p.workMode),
    requiredSkills: skills.required,
    preferredSkills: skills.preferred,
    educationRequirements: educationRequirements(text),
    certificationRequirements: certificationRequirements(text),
    experienceYearsMin: years.min,
    experienceYearsMax: years.max,
    languageRequirements: languageRequirements(text),
    workAuthorization: workAuthorization(text),
    sponsorship: sponsorship(text),
  };
  return { ...fields, canonicalHash: canonicalHash({ ...fields, country: p.country }, { source: p.source, externalId: p.externalId }) };
}

/** Columns for the Job row from the canonical fields (JSON arrays as text). */
export function canonicalColumns(c: CanonicalFields) {
  return {
    normalizedTitle: c.normalizedTitle,
    normalizedCompany: c.normalizedCompany,
    postalRegion: c.postalRegion,
    canonicalHash: c.canonicalHash,
    requiredSkills: JSON.stringify(c.requiredSkills),
    preferredSkills: JSON.stringify(c.preferredSkills),
    educationRequirements: JSON.stringify(c.educationRequirements),
    certificationRequirements: JSON.stringify(c.certificationRequirements),
    experienceYearsMin: c.experienceYearsMin,
    experienceYearsMax: c.experienceYearsMax,
    languageRequirements: JSON.stringify(c.languageRequirements),
    workAuthorization: c.workAuthorization,
    sponsorship: c.sponsorship,
  };
}

/** NOC broad category of a NOC 2021 code ("21234" → "noc:2"); null otherwise. */
export function occupationFamily(nocCode: string | null | undefined): string | null {
  const m = (nocCode ?? '').trim().match(/^(\d)\d{4}$/);
  return m ? `noc:${m[1]}` : null;
}
