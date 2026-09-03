/**
 * Stage 11 — thread → folder association, pure and explainable.
 *
 * A thread is matched to at most one application folder by named signals —
 * a known contact's address, the employer's domain, an applicant-tracking
 * system's sender combined with the posting's words, the subject naming
 * the company or the role, timing after the application went out — each
 * with a weight, summed and capped. The result is one of three states:
 *
 *   auto     confidence ≥ AUTO_THRESHOLD and no rival folder within the
 *            ambiguity margin — filed automatically, still reversible;
 *   pending  PENDING_THRESHOLD ≤ confidence < AUTO_THRESHOLD, or a rival
 *            too close — shown to the applicant, NEVER auto-filed;
 *   none     below the pending threshold — left unassociated.
 *
 * Detection (interview, offer) reads the subject and the presence of a
 * calendar invite. It never reads a message body here: bodies are
 * RESTRICTED (DATA_CLASSIFICATION.md) and this module receives none.
 * Nothing here calls a model.
 */
export interface ThreadFacts {
  subject: string;
  /** Every participant address, lower-cased, including the applicant's own. */
  participants: string[];
  /** The address the latest inbound message came from, lower-cased. */
  from: string;
  lastMessageAt: Date;
  hasCalendarInvite: boolean;
}

export interface FolderCandidate {
  applicationId: string;
  company: string;
  /** Stage 06 normalised company (lower-case, legal forms stripped). */
  normalizedCompany: string;
  jobTitle: string;
  /** Contact addresses on the folder (Stage 10), lower-cased. */
  contactEmails: string[];
  appliedAt: Date | null;
  atsVendor: string | null;
}

export interface AssociationSignal {
  name: string;
  weight: number;
}

export interface Association {
  applicationId: string | null;
  confidence: number;
  status: 'auto' | 'pending' | 'none';
  signals: AssociationSignal[];
  /** A second folder scored within the ambiguity margin. */
  rivalApplicationId: string | null;
}

export const AUTO_THRESHOLD = 0.85;
export const PENDING_THRESHOLD = 0.5;
/** Two folders this close cannot be told apart automatically. */
export const AMBIGUITY_MARGIN = 0.1;

/** Sender domains of applicant-tracking systems: strong evidence of a hiring process, weak evidence of WHICH one. */
export const ATS_SENDER_DOMAINS: readonly string[] = ['greenhouse.io', 'greenhouse-mail.io', 'lever.co', 'hire.lever.co', 'myworkday.com', 'workday.com', 'icims.com', 'smartrecruiters.com', 'bamboohr.com', 'ashbyhq.com', 'jobvite.com', 'successfactors.com', 'taleo.net', 'workable.com', 'recruitee.com'];

const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'proton.me', 'protonmail.com']);
const NOISE_WORDS = new Set(['inc', 'ltd', 'llc', 'corp', 'co', 'the', 'group', 'limited', 'company', 'and', 'of', 'canada', 'technologies', 'technology', 'solutions', 'services', 'systems', 'labs', 'analytics', 'software', 'consulting', 'partners', 'global', 'international']);

export function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at === -1 ? '' : address.slice(at + 1).toLowerCase().trim();
}

/** Distinctive tokens of a company name ("Maple Analytics Inc" → ["maple"]). */
export function companyTokens(normalizedCompany: string): string[] {
  return normalizedCompany
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !NOISE_WORDS.has(t));
}

function subjectHas(subject: string, phrase: string): boolean {
  const s = ` ${subject.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  const p = ` ${phrase.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  return p.trim().length >= 4 && s.includes(p);
}

function isAtsDomain(domain: string): boolean {
  return ATS_SENDER_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** Score one folder against one thread. Exported for the fixture test's per-signal assertions. */
export function scoreFolder(thread: ThreadFacts, folder: FolderCandidate): AssociationSignal[] {
  const signals: AssociationSignal[] = [];
  const fromDomain = domainOf(thread.from);
  const tokens = companyTokens(folder.normalizedCompany || folder.company);
  const contactDomains = new Set(folder.contactEmails.map(domainOf).filter((d) => d && !FREE_MAIL.has(d)));

  if (folder.contactEmails.some((c) => thread.participants.includes(c))) signals.push({ name: 'contact_address', weight: 0.6 });
  if (fromDomain && contactDomains.has(fromDomain)) signals.push({ name: 'contact_domain', weight: 0.45 });
  else if (fromDomain && !FREE_MAIL.has(fromDomain) && !isAtsDomain(fromDomain) && domainNamesCompany(fromDomain, folder, tokens)) signals.push({ name: 'company_domain', weight: 0.5 });

  const subjectCompany = tokens.some((t) => subjectHas(thread.subject, t)) || subjectHas(thread.subject, folder.company);
  // A title with no distinctive word ("PM", "HR Rep") can never be named by a subject: `every` on an empty list would say it always is.
  const words = titleWords(folder.jobTitle);
  const subjectTitle = subjectHas(thread.subject, folder.jobTitle) || (words.length > 0 && words.every((w) => subjectHas(thread.subject, w)));
  if (subjectCompany) signals.push({ name: 'subject_company', weight: 0.3 });
  if (subjectTitle) signals.push({ name: 'subject_title', weight: 0.25 });
  // An ATS sender says "a hiring process", not which one: it counts only beside a subject match.
  if (isAtsDomain(fromDomain) && (subjectCompany || subjectTitle)) signals.push({ name: 'ats_sender', weight: 0.25 });

  if (folder.appliedAt) {
    if (thread.lastMessageAt.getTime() >= folder.appliedAt.getTime()) signals.push({ name: 'after_application', weight: 0.1 });
    else signals.push({ name: 'before_application', weight: -0.4 });
  }
  return signals;
}

/**
 * A domain names the company when one of its labels IS the company's name
 * run together ("mapleanalytics", "birchfinancial") or one distinctive
 * token on its own ("maple"). A label that merely starts with a token
 * ("maplewoodcondos") does not — that is how a condo developer's mail would
 * land in an analytics application's folder.
 */
function domainNamesCompany(domain: string, folder: FolderCandidate, tokens: string[]): boolean {
  const labels = domain.split('.').filter(Boolean);
  const allWords = (folder.normalizedCompany || folder.company).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const forms = new Set([allWords.join(''), tokens.join(''), ...tokens]);
  forms.delete('');
  return labels.some((label) => forms.has(label));
}

function titleWords(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !['senior', 'junior', 'lead', 'staff', 'principal', 'intermediate'].includes(w));
}

export function confidenceOf(signals: AssociationSignal[]): number {
  const sum = signals.reduce((n, s) => n + s.weight, 0);
  return Math.max(0, Math.min(1, Math.round(sum * 100) / 100));
}

export function associateThread(thread: ThreadFacts, folders: FolderCandidate[]): Association {
  // Ties break on the company name, a stable and human-legible order, never on an id.
  const scored = folders
    .map((f) => {
      const signals = scoreFolder(thread, f);
      return { applicationId: f.applicationId, company: f.company, signals, confidence: confidenceOf(signals) };
    })
    .filter((s) => s.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence || a.company.localeCompare(b.company) || a.applicationId.localeCompare(b.applicationId));
  const best = scored[0];
  if (!best || best.confidence < PENDING_THRESHOLD) return { applicationId: null, confidence: best?.confidence ?? 0, status: 'none', signals: best?.signals ?? [], rivalApplicationId: null };
  const rival = scored[1] && best.confidence - scored[1].confidence < AMBIGUITY_MARGIN ? scored[1].applicationId : null;
  const status: Association['status'] = best.confidence >= AUTO_THRESHOLD && !rival ? 'auto' : 'pending';
  return { applicationId: best.applicationId, confidence: best.confidence, status, signals: best.signals, rivalApplicationId: rival };
}

// --- detection (subject and invite only; bodies never reach this module) ----------

export interface Detection {
  interview: boolean;
  offer: boolean;
  reasons: string[];
}

const INTERVIEW_WORDS = [/\binterview/i, /\bphone screen\b/i, /\bscreening call\b/i, /\bschedule (a|your) (call|conversation|chat)\b/i, /\bonsite\b/i, /\btechnical (assessment|round)\b/i];
const OFFER_WORDS = [/\boffer( letter| of employment)?\b/i, /\bcompensation (package|details)\b/i, /\bwe would like to extend\b/i];
const NOT_OFFER = [/\bspecial offer\b/i, /\boffers?\b.*\b(sale|discount|deal|%)/i, /\bnewsletter\b/i];

export function detectSignals(thread: ThreadFacts): Detection {
  const reasons: string[] = [];
  const interview = INTERVIEW_WORDS.some((r) => r.test(thread.subject)) || thread.hasCalendarInvite;
  if (interview) reasons.push(thread.hasCalendarInvite ? 'calendar_invite' : 'subject_interview');
  const offer = OFFER_WORDS.some((r) => r.test(thread.subject)) && !NOT_OFFER.some((r) => r.test(thread.subject));
  if (offer) reasons.push('subject_offer');
  return { interview, offer, reasons };
}
