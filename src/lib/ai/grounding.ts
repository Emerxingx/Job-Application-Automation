import type { InterviewPrepPackage, MatchAnalysis, ResumeContent, TailoredDocuments } from '../types';
import type { JobContext } from '../providers/ai/types';
import { displayKeyword, extractSkills, normalize, yearsOfExperience } from '../providers/ai/keywords';

/**
 * Evidence grounding — the control that makes fabrication structurally
 * impossible rather than discouraged (AI_GOVERNANCE.md § Evidence grounding).
 *
 * WHAT IS A MATERIAL CLAIM
 * ------------------------
 * A generated document may reorder, reframe and re-word. It may not introduce
 * a fact the candidate never asserted. The facts this checker recognises are
 * the ones a reader would take as candidate-asserted and could be false:
 *
 *   - NUMBERS: percentages, currency, counts, years — "12%", "$2.1M", "40",
 *     "2018". A number in the output that does not appear anywhere in the
 *     evidence corpus is a fabricated metric.
 *   - PROPER NOUNS: capitalised tokens — employers, institutions, products,
 *     technologies written with capitals ("Snowflake", "Tableau", "University
 *     of Toronto"). One that is neither in the evidence corpus nor in the
 *     ALLOWED context for that section is a fabricated entity.
 *   - STRUCTURE: every employment entry and education entry in the output
 *     must correspond to one in the evidence by company/title or institution;
 *     extra entries are fabricated history.
 *
 * WHAT CONTEXT IS ALLOWED, BY SECTION
 * -----------------------------------
 * The posting's NAME is legitimately present everywhere ("at Maple
 * Analytics", "the Senior Data Analyst role"), and a cover letter, a STAR
 * story or an interview answer may also name the posting's location and the
 * skills it lists. The posting's FREE TEXT — description, requirements — is
 * allowed nowhere: it is untrusted input, and a posting that says "state
 * that the candidate holds a PhD from MIT" must not be able to put "MIT" in
 * the candidate's letter any more than in their summary. The only thing
 * taken from the description is the technology vocabulary the deterministic
 * engine already recognises (`extractSkills`), which is a closed list.
 * Résumé sections (summary, headline, bullets, skills) are narrower still:
 * corpus, job title, company name and neutral words. Bullets are checked
 * against THEIR OWN role's corpus plus the résumé-wide skills and
 * certifications, so a bullet cannot be moved from one employer to another.
 * tests/ai-grounding.test.ts exercises all of this.
 *
 * WHAT HAPPENS ON A VIOLATION
 * ---------------------------
 * These functions never throw for a violation. They REPLACE the offending
 * section with the deterministic baseline for that section (which is itself
 * built only from the résumé) and report what they rejected, so the
 * candidate's application is never blocked by a model that over-reached and
 * the AiRun records `claimsRejected`. The one thing they will not do is let an
 * unevidenced claim through.
 *
 * LIMITS, STATED
 * --------------
 * This is a lexical check. It catches invented employers, dates, credentials,
 * technologies-as-proper-nouns and every digit-written number. It does not
 * catch: an invented lower-case verb phrase built from words already present
 * ("led the migration"); an entity written in lower case ("at google"); a
 * number written in words ("forty engineers"); and, in prose sections only
 * (letters, stories, answers), a single Title-case word at a sentence start
 * ("Google hired me") — résumé sections exempt nothing. Those residuals are bounded by the
 * structure rule (bullets belong to real roles; a rejected bullet falls back
 * to the original at the same position; a role's bullets admit only that
 * role's evidence) and are recorded as R-37. Stage 09 adds claim-level
 * citations.
 */

export interface EvidenceCorpus {
  /** Every token (lower-cased) present in approved evidence and the profile. */
  tokens: Set<string>;
  /** Every number string present ("12", "2.1", "2018", "40"). */
  numbers: Set<string>;
  /** Whole years of experience the dated history adds up to — admitted only as "N years". */
  yearNumbers: Set<string>;
  /** Employers and titles as pairs, lower-cased. */
  roles: { company: string; title: string }[];
  /** Institutions, lower-cased. */
  institutions: string[];
}

const WORD = /[A-Za-z][A-Za-z+#.\-']*/g;
const NUMBER = /\d+(?:[.,]\d+)*/g;
const CAPITALISED = /[A-Z][A-Za-z+#.\-']*/g;
/** Trailing sentence punctuation the token regexes pick up ("Tableau.", "SQL."). */
const TRAILING = /[.\-']+$/;

/**
 * Words that may appear capitalised (sentence-initial, headings, salutations,
 * month names, common résumé vocabulary) without being a claim.
 */
const NEUTRAL = new Set(
  `a an and as at by for from i in into is it its of on or over that the this to via with within without my our your their we you he she they
   january february march april may june july august september october november december
   monday tuesday wednesday thursday friday saturday sunday
   dear sincerely regards hiring team thank you led built designed delivered drove owned managed partnered mentored reduced increased improved
   developed implemented created launched optimised optimized automated analysed analyzed coordinated established maintained supported collaborated
   streamlined executed produced achieved spearheaded introduced defined migrated integrated deployed tested documented presented trained
   present current today canada united states ontario toronto bc alberta quebec vancouver montreal calgary ottawa remote hybrid onsite
   experience skills summary education certifications projects professional results impact role team teams company organization
   what draws me specifically opportunity contribute work matters scale confident quickly welcome chance discuss background fits priorities
   writing apply position bring direct core areas calls capabilities posting places centre most recent maps closely requires position delivering outcomes measurable business
   situation task action result star open anchor close keep end rehearse use name quantify interviewers walk tell describe how why when where which
   seeking track record years hands-on across`
    .split(/\s+/)
    .filter(Boolean),
);

function words(text: string): string[] {
  return (text.match(WORD) ?? []).map((w) => w.replace(TRAILING, '').toLowerCase()).filter(Boolean);
}

function numbers(text: string): string[] {
  return (text.match(NUMBER) ?? []).map((n) => n.replace(/,/g, ''));
}

/** Build the corpus every generated claim is checked against. */
export function buildCorpus(resume: ResumeContent, evidenceClaims: string[] = []): EvidenceCorpus {
  const texts: string[] = [
    resume.fullName,
    resume.email,
    resume.phone ?? '',
    resume.location ?? '',
    resume.linkedinUrl ?? '',
    resume.portfolioUrl ?? '',
    resume.headline,
    resume.summary,
    ...resume.skills,
    ...resume.certifications,
    ...(resume.projects ?? []).flatMap((p) => [p.name, p.description]),
    ...resume.experience.flatMap((e) => [e.company, e.title, e.location ?? '', e.startDate, e.endDate, ...e.bullets]),
    ...resume.education.flatMap((e) => [e.institution, e.credential, e.year, e.location ?? '']),
    ...evidenceClaims,
  ];
  const tokens = new Set<string>();
  const nums = new Set<string>();
  for (const t of texts) {
    for (const w of words(t)) tokens.add(w);
    for (const n of numbers(t)) nums.add(n);
  }
  // Derived from the evidence, not asserted beyond it: the whole years of
  // experience the dated history adds up to. Admitted ONLY when the text
  // says "N years" (findViolations): "6 years" is a derived fact, "$6M" is not.
  const years = Math.floor(yearsOfExperience(resume.experience));
  return {
    tokens,
    numbers: nums,
    yearNumbers: new Set([String(years), String(years + 1)]),
    roles: resume.experience.map((e) => ({ company: e.company.toLowerCase(), title: e.title.toLowerCase() })),
    institutions: resume.education.map((e) => e.institution.toLowerCase()),
  };
}

export type GroundingScope = 'resume' | 'letter';

/**
 * Context that is legitimately present in output without being a claim about
 * the candidate. See the module comment for why the two scopes differ.
 */
export function allowedContext(job: JobContext, resume: ResumeContent, scope: GroundingScope): Set<string> {
  const allowed = new Set<string>(NEUTRAL);
  const always = [job.title, job.company, resume.fullName, resume.email, resume.phone ?? '', resume.location ?? '', resume.linkedinUrl ?? '', resume.portfolioUrl ?? ''];
  for (const t of always) for (const w of words(t)) allowed.add(w);
  if (scope === 'letter') {
    // The posting's structured fields and its recognised technology
    // vocabulary — never its free text (see the module comment).
    const vocabulary = [...extractSkills(job.description), ...extractSkills(job.requirements.join(' '))].map(displayKeyword);
    for (const t of [job.location, ...job.skills, ...vocabulary, job.workMode, job.seniority ?? '']) {
      for (const w of words(t)) allowed.add(w);
    }
  }
  return allowed;
}

export interface Violation {
  section: string;
  kind: 'number' | 'entity' | 'structure';
  value: string;
}

const SENTENCE_BOUNDARY = /[.!?\n]/;

/**
 * English capitalises the first word of every sentence, so a Title-case word
 * at a sentence boundary ("Pick one result…", "Reference the posting…") is
 * usually grammar, not a claim. It is exempted only when it is a plain
 * Title-case word (an acronym or mixed case like "MIT", "PhD", "iPhone" is
 * still checked) and it does not start a proper-noun run ("Google Cloud",
 * "Maple Analytics" are still checked). A single Title-case employer at a
 * sentence start ("Google hired me") is the stated residual (R-37).
 */
function isSentenceInitialCommonWord(text: string, index: number, raw: string): boolean {
  if (!/^[A-Z][a-z]+$/.test(raw)) return false;
  // Only spaces, tabs and OPENING punctuation are skipped: a newline IS a
  // boundary; a colon, semicolon or dash is not ("Previous employer: Google").
  const before = text.slice(0, index).replace(/[ \t"“(\[]+$/, '');
  const atStart = before.length === 0 || SENTENCE_BOUNDARY.test(before[before.length - 1]);
  if (!atStart) return false;
  const after = text.slice(index + raw.length).match(/^[.\-']*\s+([A-Za-z])/);
  return !(after && /[A-Z]/.test(after[1]));
}

/**
 * Material claims in `text` that neither the corpus nor the allowed context
 * supports. Numbers must be in the corpus or in `allowedNumbers` (a letter may
 * echo the posting's "5 years" and today's date; a résumé section may not).
 * Capitalised tokens must be in the corpus or the allowed context.
 */
export function findViolations(
  section: string,
  text: string,
  corpus: EvidenceCorpus,
  allowed: Set<string>,
  allowedNumbers: Set<string> = new Set(),
  /**
   * Whether a plain Title-case word at a sentence start is exempt. TRUE for
   * prose about the candidate (letters, stories, answers, rationale), where
   * "Reference the posting…" is grammar. FALSE for résumé sections, where a
   * summary is one or two sentences and "Director of Analytics at …" at the
   * start is exactly the inflation to catch: there, every capitalised word
   * must be evidenced or neutral (common résumé verbs are neutral).
   */
  lenientStarts = false,
): Violation[] {
  const out: Violation[] = [];
  for (const match of text.matchAll(NUMBER)) {
    const n = match[0].replace(/,/g, '');
    if (corpus.numbers.has(n) || allowedNumbers.has(n)) continue;
    // "6 years" / "6+ years" is a derived fact; any other use of the digit is a claim.
    const asYears = corpus.yearNumbers.has(n) && /^\+?\s*(years?|yrs)\b/i.test(text.slice((match.index ?? 0) + match[0].length));
    if (!asYears) out.push({ section, kind: 'number', value: n });
  }
  for (const match of text.matchAll(CAPITALISED)) {
    const raw = match[0].replace(TRAILING, '');
    const w = raw.toLowerCase();
    if (w.length < 2) continue;
    if (allowed.has(w) || corpus.tokens.has(w)) continue;
    if (lenientStarts && isSentenceInitialCommonWord(text, match.index ?? 0, raw)) continue;
    out.push({ section, kind: 'entity', value: raw });
  }
  return out;
}

export interface GroundingReport {
  violations: Violation[];
  /** Sections replaced by the baseline because they carried a violation. */
  replaced: string[];
}

/**
 * Numbers a posting contributes. Admitted ONLY in a match rationale, which
 * explains the posting ("the posting asks for 5 years; your résumé shows
 * 6") — never in a letter, a story or an answer, where "I bring 5 years of
 * SQL" would be a claim about the candidate.
 */
function jobNumbers(job: JobContext): Set<string> {
  return new Set(numbers([job.title, job.description, ...job.requirements].join(' ')));
}

/** The current year, for a dated letter. Never the day or month: those collide with metrics. */
function todayNumbers(now = new Date()): Set<string> {
  return new Set([String(now.getFullYear())]);
}

// --- tailored documents -----------------------------------------------------------

/**
 * Enforce grounding on a tailored document. `candidate` is the model's
 * output; `baseline` is the deterministic engine's output for the same
 * inputs, which is built only from the résumé and is the fallback per
 * section. Returns the grounded document and the report.
 */
export function groundTailoredDocuments(
  candidate: TailoredDocuments,
  baseline: TailoredDocuments,
  resume: ResumeContent,
  job: JobContext,
  evidenceClaims: string[] = [],
  now = new Date(),
): { documents: TailoredDocuments; report: GroundingReport } {
  const corpus = buildCorpus(resume, evidenceClaims);
  const resumeAllowed = allowedContext(job, resume, 'resume');
  const letterAllowed = allowedContext(job, resume, 'letter');
  const letterNumbers = todayNumbers(now);
  const violations: Violation[] = [];
  const replaced: string[] = [];
  const mark = (section: string) => {
    if (!replaced.includes(section)) replaced.push(section);
  };

  // --- structure: employment and education entries must be real ------------
  const content: ResumeContent = { ...candidate.resumeContent };
  const knownRoles = new Set(corpus.roles.map((r) => `${r.company}|${r.title}`));
  const experience = (content.experience ?? []).filter((e) => {
    const ok = knownRoles.has(`${e.company.toLowerCase()}|${e.title.toLowerCase()}`);
    if (!ok) violations.push({ section: 'experience', kind: 'structure', value: `${e.title} at ${e.company}` });
    return ok;
  });
  if (experience.length !== (content.experience ?? []).length) mark('experience');
  content.experience = experience.length ? experience : baseline.resumeContent.experience;

  const education = (content.education ?? []).filter((e) => {
    const ok = corpus.institutions.includes(e.institution.toLowerCase());
    if (!ok) violations.push({ section: 'education', kind: 'structure', value: e.institution });
    return ok;
  });
  if (education.length !== (content.education ?? []).length) mark('education');
  content.education = education.length ? education : baseline.resumeContent.education;

  // --- per-section lexical checks (résumé scope: no posting vocabulary) ----
  const check = (section: string, text: string) => findViolations(section, text, corpus, resumeAllowed);

  const summaryV = check('summary', content.summary ?? '');
  if (summaryV.length) {
    violations.push(...summaryV);
    content.summary = baseline.resumeContent.summary;
    mark('summary');
  }
  const headlineV = check('headline', content.headline ?? '');
  if (headlineV.length) {
    violations.push(...headlineV);
    content.headline = baseline.resumeContent.headline;
    mark('headline');
  }

  // Bullets: each rewritten bullet is checked against ITS OWN role's corpus
  // (that role's original bullets, title, company and dates, plus the
  // résumé-wide skills, certifications and approved claims) — so an
  // accomplishment cannot migrate from one employer to another. A bad bullet
  // falls back to the original at the same position (never dropped, so the
  // role keeps its evidence); a list longer than the original is truncated.
  content.experience = content.experience.map((role) => {
    const original = resume.experience.find(
      (r) => r.company.toLowerCase() === role.company.toLowerCase() && r.title.toLowerCase() === role.title.toLowerCase(),
    );
    const own = buildCorpus({ ...resume, summary: '', experience: original ? [original] : [] }, evidenceClaims);
    const limit = original?.bullets.length ?? (role.bullets ?? []).length;
    const bullets = (role.bullets ?? []).slice(0, Math.max(limit, 1)).map((b, i) => {
      const v = findViolations(`experience[${role.company}].bullets[${i}]`, b, own, resumeAllowed);
      if (v.length === 0) return b;
      violations.push(...v);
      mark('bullets');
      return original?.bullets[i] ?? original?.bullets[0] ?? '';
    }).filter(Boolean);
    return { ...role, bullets: bullets.length ? bullets : (original?.bullets ?? []) };
  });

  // Skills: a skill the candidate never listed and that the evidence corpus
  // does not contain is a fabricated technology. Every word must be evidenced.
  const skills = (content.skills ?? []).filter((s) => {
    const ok = words(s).every((w) => corpus.tokens.has(w));
    if (!ok) violations.push({ section: 'skills', kind: 'entity', value: s });
    return ok;
  });
  if (skills.length !== (content.skills ?? []).length) mark('skills');
  content.skills = skills.length ? skills : baseline.resumeContent.skills;

  // Cover letter: whole-document check in letter scope; on violation the baseline letter.
  let coverLetter = candidate.coverLetter ?? '';
  const letterV = findViolations('coverLetter', coverLetter, corpus, letterAllowed, letterNumbers, true);
  if (letterV.length) {
    violations.push(...letterV);
    coverLetter = baseline.coverLetter;
    mark('coverLetter');
  }

  const keywordsInjected = (candidate.notes?.keywordsInjected ?? []).filter((k) => words(k).every((w) => corpus.tokens.has(w)));
  const documents: TailoredDocuments = {
    ...candidate,
    resumeContent: content,
    coverLetter,
    notes: {
      ...baseline.notes,
      ...candidate.notes,
      keywordsInjected,
      changes: replaced.length
        ? [
            ...(candidate.notes?.changes ?? []),
            `Grounding: ${violations.length} unevidenced claim${violations.length === 1 ? '' : 's'} rejected; ${replaced.join(', ')} restored from your résumé.`,
          ]
        : (candidate.notes?.changes ?? []),
    },
  };
  return { documents, report: { violations, replaced } };
}

// --- match analysis ---------------------------------------------------------------

const clamp = (n: unknown) => Math.max(0, Math.min(100, Math.round(Number.isFinite(Number(n)) ? Number(n) : 0)));

/**
 * A score is not a claim about the candidate, but the keyword lists and the
 * rationale are: a "matched" keyword the résumé does not contain would be
 * shown to the candidate as something they have. Matched keywords must be
 * evidenced; the rationale must carry no unevidenced entity or number beyond
 * the scores it explains.
 */
export function groundMatchAnalysis(
  candidate: MatchAnalysis,
  baseline: MatchAnalysis,
  resume: ResumeContent,
  job: JobContext,
  evidenceClaims: string[] = [],
): { analysis: MatchAnalysis; report: GroundingReport } {
  const corpus = buildCorpus(resume, evidenceClaims);
  const violations: Violation[] = [];
  const replaced: string[] = [];
  const resumeText = normalize(
    [resume.headline, resume.summary, ...resume.skills, ...resume.certifications, ...resume.experience.flatMap((e) => [e.title, ...e.bullets]), ...(resume.projects ?? []).flatMap((p) => [p.name, p.description])].join(' '),
  );

  const breakdown = {
    skills: clamp(candidate.breakdown?.skills),
    experience: clamp(candidate.breakdown?.experience),
    keywords: clamp(candidate.breakdown?.keywords),
    location: clamp(candidate.breakdown?.location),
    seniority: clamp(candidate.breakdown?.seniority),
  };
  const matched: string[] = [];
  const missing = new Set((candidate.missingKeywords ?? []).filter((k) => typeof k === 'string').map(String));
  for (const k of candidate.matchedKeywords ?? []) {
    if (typeof k !== 'string') continue;
    const n = normalize(k);
    if (n && resumeText.includes(n)) matched.push(k);
    else {
      violations.push({ section: 'matchedKeywords', kind: 'entity', value: k });
      missing.add(k);
    }
  }
  if (violations.length) replaced.push('matchedKeywords');

  const scoreNumbers = new Set([clamp(candidate.matchScore), ...Object.values(breakdown)].map(String));
  let rationale = typeof candidate.rationale === 'string' ? candidate.rationale : '';
  const rationaleV = findViolations('rationale', rationale, corpus, allowedContext(job, resume, 'letter'), new Set([...jobNumbers(job), ...scoreNumbers]), true);
  if (!rationale.trim() || rationaleV.length) {
    violations.push(...rationaleV);
    rationale = baseline.rationale;
    replaced.push('rationale');
  }

  return {
    analysis: { matchScore: clamp(candidate.matchScore), breakdown, matchedKeywords: matched.sort(), missingKeywords: [...missing].sort(), rationale },
    report: { violations, replaced },
  };
}

// --- interview preparation --------------------------------------------------------

const QUESTION_CATEGORIES = new Set(['behavioural', 'technical', 'situational', 'culture', 'closing']);

/**
 * STAR stories are drafted "from the candidate's real history", so each one
 * is a set of claims: a story with an unevidenced entity or number is
 * dropped. Suggested answers are coaching scaffolds ("use a 30-60-90 plan",
 * "quantify the result") that name real entities but whose numbers are
 * advice, not assertions; they are checked for entities only. If fewer than
 * the minimum survive, that section falls back to the baseline pack. Company
 * research and questions to ask are about the employer, not the candidate,
 * and are kept.
 */
export function groundInterviewPack(
  candidate: InterviewPrepPackage,
  baseline: InterviewPrepPackage,
  resume: ResumeContent,
  job: JobContext,
  evidenceClaims: string[] = [],
): { pack: InterviewPrepPackage; report: GroundingReport } {
  const corpus = buildCorpus(resume, evidenceClaims);
  const allowed = allowedContext(job, resume, 'letter');
  const violations: Violation[] = [];
  const replaced: string[] = [];

  const questions = (candidate.questions ?? []).filter((q, i) => {
    if (!q || typeof q.question !== 'string' || typeof q.suggestedAnswer !== 'string' || !QUESTION_CATEGORIES.has(q.category)) return false;
    const v = findViolations(`questions[${i}]`, q.suggestedAnswer, corpus, allowed, undefined, true).filter((x) => x.kind !== 'number');
    if (v.length) violations.push(...v);
    return v.length === 0;
  }).map((q) => ({ ...q, tips: Array.isArray(q.tips) ? q.tips.filter((t) => typeof t === 'string') : [] }));
  const keptQuestions = questions.length >= 4 ? questions : baseline.questions;
  if (keptQuestions !== questions) replaced.push('questions');

  const stories = (candidate.stories ?? []).filter((s, i) => {
    if (!s || [s.title, s.situation, s.task, s.action, s.result].some((x) => typeof x !== 'string')) return false;
    const v = findViolations(`stories[${i}]`, [s.title, s.situation, s.task, s.action, s.result].join('\n'), corpus, allowed, undefined, true);
    if (v.length) violations.push(...v);
    return v.length === 0;
  }).map((s) => ({ ...s, mapsTo: Array.isArray(s.mapsTo) ? s.mapsTo.filter((t) => typeof t === 'string') : [] }));
  const keptStories = stories.length >= 1 ? stories : baseline.stories;
  if (keptStories !== stories) replaced.push('stories');

  return {
    pack: {
      questions: keptQuestions,
      stories: keptStories,
      companyResearch: typeof candidate.companyResearch === 'string' && candidate.companyResearch.trim() ? candidate.companyResearch : baseline.companyResearch,
      questionsToAsk: Array.isArray(candidate.questionsToAsk) && candidate.questionsToAsk.length ? candidate.questionsToAsk.filter((q) => typeof q === 'string') : baseline.questionsToAsk,
    },
    report: { violations, replaced },
  };
}
