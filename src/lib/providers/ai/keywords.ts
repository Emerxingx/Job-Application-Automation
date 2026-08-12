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

  for (const skill of SKILL_VOCABULARY) {
    const needle = normalize(skill);
    // Word-boundary-ish check to avoid matching "r" inside "react".
    const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegex(needle)}([^a-z0-9]|$)`);
    if (pattern.test(haystack)) found.add(skill);
  }

  return [...found];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
