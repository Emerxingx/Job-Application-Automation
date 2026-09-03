import { normalize } from '@/lib/providers/ai/keywords';

/**
 * Stage 08 — the semantic comparison stage, deterministic.
 *
 * The brief names pgvector for this stage. The `vector` extension is NOT
 * available on the local PostgreSQL or the CI service container, and the
 * staging project is unreachable from the build environment (R-34), so no
 * embedding is computed anywhere in this codebase and none is pretended:
 * `INTEGRATION_REGISTER.md` lists pgvector as BLOCKED. What runs instead is
 * a closed equivalence map — spellings, abbreviations and near-synonyms of
 * the skill vocabulary — applied to both sides before comparison, so
 * "PostgreSQL" on a résumé satisfies "Postgres" on a posting and every such
 * match is labelled `semantic`, never passed off as an exact one. The map is
 * data, reviewable, and the stage is replaceable by an embedding comparer
 * behind the same function when the extension exists.
 */

/** Groups of equivalent spellings. The first entry is the canonical form used for display. */
export const EQUIVALENCE_GROUPS: readonly (readonly string[])[] = [
  ['postgresql', 'postgres', 'psql'],
  ['javascript', 'js', 'ecmascript'],
  ['typescript', 'ts'],
  ['node.js', 'nodejs', 'node'],
  ['react', 'reactjs', 'react.js'],
  ['next.js', 'nextjs'],
  ['vue', 'vuejs', 'vue.js'],
  ['kubernetes', 'k8s'],
  ['machine learning', 'ml'],
  ['deep learning', 'dl', 'neural networks'],
  ['nlp', 'natural language processing'],
  ['llms', 'llm', 'large language models'],
  ['gcp', 'google cloud', 'google cloud platform'],
  ['aws', 'amazon web services'],
  ['azure', 'microsoft azure'],
  ['ci/cd', 'cicd', 'continuous integration', 'continuous delivery', 'continuous deployment'],
  ['power bi', 'powerbi'],
  ['google analytics', 'ga4'],
  ['a/b testing', 'ab testing', 'split testing', 'experimentation'],
  ['data modelling', 'data modeling'],
  ['financial modelling', 'financial modeling'],
  ['etl', 'elt'],
  ['data warehouse', 'data warehousing', 'dwh'],
  ['rest', 'restful', 'rest apis', 'rest api'],
  ['microservices', 'micro-services', 'microservice architecture'],
  ['stakeholder management', 'stakeholder engagement'],
  ['user research', 'ux research'],
  ['okrs', 'okr'],
  ['pmp', 'project management professional'],
  ['cpa', 'chartered professional accountant'],
  ['bls', 'basic life support'],
  ['acls', 'advanced cardiac life support'],
  ['bilingual', 'english and french', 'french and english'],
  ['c#', 'csharp', 'c sharp'],
  ['c++', 'cpp'],
  ['go', 'golang'],
];

const CANONICAL = new Map<string, string>();
for (const group of EQUIVALENCE_GROUPS) {
  const head = normalize(group[0]);
  for (const member of group) CANONICAL.set(normalize(member), head);
}

/** The canonical form of a skill under the equivalence map; the input itself when it has none. */
export function canonicalSkill(skill: string): string {
  const n = normalize(skill);
  return CANONICAL.get(n) ?? n;
}

export interface SemanticMatch {
  /** The posting's term as the posting wrote it (normalised). */
  required: string;
  /** The résumé term that satisfied it. */
  satisfiedBy: string;
  /** How: `exact` (same normalised string) or `semantic` (equivalent under the map). */
  how: 'exact' | 'semantic';
}

/**
 * Compare a posting's terms against a candidate's terms. Every posting term
 * is either satisfied (exactly or through the equivalence map) or missing.
 * Pure and deterministic; order-independent.
 */
export function compareTerms(required: string[], held: string[]): { matched: SemanticMatch[]; missing: string[] } {
  const heldNorm = new Map<string, string>(); // normalised → as held
  const heldCanonical = new Map<string, string>(); // canonical → as held
  for (const h of held) {
    const n = normalize(h);
    if (!n) continue;
    if (!heldNorm.has(n)) heldNorm.set(n, n);
    const c = canonicalSkill(n);
    if (!heldCanonical.has(c)) heldCanonical.set(c, n);
  }
  const matched: SemanticMatch[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const r of required) {
    const n = normalize(r);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    if (heldNorm.has(n)) {
      matched.push({ required: n, satisfiedBy: n, how: 'exact' });
      continue;
    }
    const c = canonicalSkill(n);
    const by = heldCanonical.get(c);
    if (by !== undefined) {
      matched.push({ required: n, satisfiedBy: by, how: 'semantic' });
      continue;
    }
    missing.push(n);
  }
  return { matched: matched.sort((a, b) => a.required.localeCompare(b.required)), missing: missing.sort() };
}
