// Shared text-analysis helpers used by the matching and tailoring engines.

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'for', 'from', 'has', 'have',
  'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'our', 'that', 'the', 'their', 'this', 'to',
  'was', 'were', 'will', 'with', 'you', 'your', 'we', 'us', 'they', 'them', 'he', 'she', 'his',
  'her', 'who', 'what', 'when', 'where', 'how', 'all', 'can', 'if', 'not', 'out', 'up', 'about',
  'across', 'after', 'also', 'any', 'both', 'each', 'more', 'most', 'other', 'some', 'such',
  'than', 'then', 'there', 'these', 'those', 'through', 'while', 'would', 'should', 'could',
  'years', 'year', 'experience', 'work', 'working', 'role', 'team', 'teams', 'company', 'strong',
  'ability', 'plus', 'asset', 'preferred', 'required', 'including', 'etc', 'new', 'well', 'own',
]);

/**
 * Recognized skill vocabulary. Multi-word entries are matched as phrases so
 * "machine learning" is not split into two weak tokens.
 */
export const SKILL_VOCABULARY = [
  // data & analytics
  'sql', 'python', 'r', 'excel', 'tableau', 'power bi', 'looker', 'dbt', 'snowflake', 'bigquery',
  'redshift', 'airflow', 'dagster', 'spark', 'pandas', 'numpy', 'statistics', 'a/b testing',
  'experimentation', 'causal inference', 'data modelling', 'data modeling', 'etl', 'elt',
  'data governance', 'dax', 'lookml', 'data warehouse', 'machine learning', 'deep learning',
  'pytorch', 'tensorflow', 'llms', 'mlops', 'nlp',
  // engineering
  'javascript', 'typescript', 'react', 'next.js', 'node.js', 'vue', 'angular', 'graphql', 'rest',
  'java', 'c#', '.net', 'go', 'golang', 'ruby', 'rails', 'php', 'kotlin', 'swift', 'c++',
  'postgresql', 'mysql', 'mongodb', 'redis', 'kubernetes', 'docker', 'terraform', 'aws', 'azure',
  'gcp', 'ci/cd', 'microservices', 'distributed systems', 'api design', 'system design',
  'observability', 'devops', 'linux', 'git',
  // product / delivery
  'product strategy', 'roadmapping', 'agile', 'scrum', 'kanban', 'jira', 'confluence',
  'stakeholder management', 'user research', 'prototyping', 'wireframing', 'okrs',
  'requirements gathering', 'process mapping', 'risk management', 'pmp', 'change management',
  'go-to-market', 'product marketing',
  // design
  'figma', 'sketch', 'adobe xd', 'design systems', 'accessibility', 'wcag', 'ux research',
  // marketing / sales
  'seo', 'sem', 'google ads', 'meta ads', 'google analytics', 'hubspot', 'salesforce',
  'content marketing', 'brand strategy', 'campaign management', 'crm', 'lead generation',
  'account management', 'churn reduction', 'email marketing', 'social media',
  // finance / ops
  'financial modelling', 'financial modeling', 'forecasting', 'budgeting', 'variance analysis',
  'sap', 'erp', 'cpa', 'cfa', 'ifrs', 'gaap', 'reconciliation', 'inventory management',
  'supply chain', 'logistics', 'vendor management', 'procurement',
  // healthcare
  'patient care', 'bls', 'acls', 'charting', 'acute care', 'care planning', 'triage',
  // universal
  'leadership', 'mentoring', 'communication', 'collaboration', 'presentation', 'documentation',
  'problem solving', 'bilingual', 'french',
];

/** Normalize text for comparison: lowercase, collapse punctuation and whitespace. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9+#./\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract meaningful single-word tokens, excluding stop words. */
export function tokenize(text: string): string[] {
  return normalize(text)
    .split(' ')
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * Pull recognized skills out of free text. Returns canonical vocabulary
 * entries, so "Node.JS" and "node.js" collapse to one keyword.
 */
export function extractSkills(text: string): string[] {
  const haystack = normalize(text);
  const found = new Set<string>();

  for (const { skill, pattern } of SKILL_PATTERNS) {
    if (pattern.test(haystack)) found.add(skill);
  }

  return [...found];
}

// Compiled once: the canonical-job pipeline calls extractSkills per sentence
// of every posting, and compiling ~150 patterns per call made a bullet-heavy
// 50 KB description cost seconds of CPU on the scan path (Stage 06 review).
// Word-boundary-ish check to avoid matching "r" inside "react".
const SKILL_PATTERNS: readonly { skill: string; pattern: RegExp }[] = SKILL_VOCABULARY.map((skill) => ({
  skill,
  pattern: new RegExp(`(^|[^a-z0-9])${escapeRegex(normalize(skill))}([^a-z0-9]|$)`),
}));

/** True when a skill string is one of the vocabulary's canonical entries. */
export function isVocabularySkill(skill: string): boolean {
  return VOCABULARY_SET.has(normalize(skill));
}
const VOCABULARY_SET = new Set(SKILL_VOCABULARY.map((s) => normalize(s)));

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word presence of a normalised term in normalised text ("go" never matches "google"). */
export function hasWord(haystack: string, term: string): boolean {
  if (!term) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRegex(term)}([^a-z0-9]|$)`).test(haystack);
}

/**
 * The résumé text the engine compares against a posting. ONE definition,
 * shared by the engine and the Stage 08 pipeline, so the pipeline's semantic
 * labels and keyword decomposition describe exactly what was scored (Stage
 * 08 review, findings 2 and 3).
 */
export function resumeCorpusText(resume: {
  headline: string;
  summary: string;
  skills: string[];
  experience: { title: string; company: string; bullets: string[] }[];
  education: { credential: string; institution: string }[];
  certifications: string[];
}): string {
  return [
    resume.headline,
    resume.summary,
    resume.skills.join(' '),
    resume.experience.map((e) => `${e.title} ${e.company} ${e.bullets.join(' ')}`).join(' '),
    resume.education.map((e) => `${e.credential} ${e.institution}`).join(' '),
    resume.certifications.join(' '),
  ].join(' ');
}

/**
 * The signal-bearing posting text the keyword dimension measures: title,
 * requirements and skills — never the full description, whose benefits and
 * EEO boilerplate no résumé contains.
 */
export function jobSignalText(job: { title: string; requirements: string[]; skills: string[] }): string {
  return `${job.title} ${job.requirements.join(' ')} ${job.skills.join(' ')}`;
}

export interface DimensionValues {
  skills: number;
  keywords: number;
  experience: number;
  seniority: number;
  location: number;
}

/**
 * The engine's combination rule, in one place: the weighted sum of the
 * dimensions, scaled by domain fit — experience, seniority and location are
 * only worth anything if the candidate can actually do the job; without the
 * scaling a 6-year analyst scores ~45 on a backend role purely for being
 * senior and local. The Stage 08 pipeline applies the same rule on every
 * route, so the governed weights always produce the recorded score.
 */
export function combineScore(breakdown: DimensionValues, weights: DimensionValues): number {
  const weighted =
    breakdown.skills * weights.skills +
    breakdown.keywords * weights.keywords +
    breakdown.experience * weights.experience +
    breakdown.seniority * weights.seniority +
    breakdown.location * weights.location;
  const domainFit = Math.min(1, 0.5 + (breakdown.skills / 100) * 0.7);
  return Math.max(0, Math.min(100, Math.round(weighted * domainFit)));
}

/** Title-case a keyword for display: "power bi" -> "Power BI". */
export function displayKeyword(keyword: string): string {
  const ACRONYMS = new Set([
    'sql', 'bi', 'etl', 'elt', 'aws', 'gcp', 'api', 'rest', 'crm', 'erp', 'sap', 'seo', 'sem',
    'ux', 'ui', 'ci/cd', 'pmp', 'cpa', 'cfa', 'okrs', 'nlp', 'llms', 'dax', 'bls', 'acls',
    'ifrs', 'gaap', 'a/b', 'r', 'dbt',
  ]);
  return keyword
    .split(' ')
    .map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/** Jaccard-style overlap between two token sets, 0..1. */
export function overlapRatio(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  const hits = a.filter((t) => setB.has(t)).length;
  return hits / a.length;
}

/** Infer seniority level from a job title. */
export function seniorityOf(title: string): number {
  const t = title.toLowerCase();
  if (/\b(vp|vice president|head of|director|chief)\b/.test(t)) return 5;
  if (/\b(principal|staff|lead)\b/.test(t)) return 4;
  if (/\b(senior|sr\.?|iii)\b/.test(t)) return 3;
  if (/\b(junior|jr\.?|entry|associate|intern|new grad|i)\b/.test(t)) return 1;
  return 2; // mid-level default
}

/** Estimate total years of experience from resume history. */
export function yearsOfExperience(experience: { startDate: string; endDate: string }[]): number {
  let months = 0;
  for (const role of experience) {
    const start = parseLooseDate(role.startDate);
    const end = /present|current/i.test(role.endDate) ? new Date() : parseLooseDate(role.endDate);
    if (!start || !end) continue;
    months += Math.max(0, (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()));
  }
  return Math.round((months / 12) * 10) / 10;
}

function parseLooseDate(value: string): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  const yearMatch = value.match(/\d{4}/);
  return yearMatch ? new Date(Number(yearMatch[0]), 0, 1) : null;
}

/** Required years pulled from requirement lines like "5+ years". */
export function requiredYears(requirements: string[]): number {
  for (const req of requirements) {
    const m = req.match(/(\d+)\s*\+?\s*years?/i);
    if (m) return Number(m[1]);
  }
  return 0;
}
