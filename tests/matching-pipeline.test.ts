/**
 * Stage 08 — the compatibility engine, pure parts (no database).
 *
 * Scoring consistency (same inputs → same score, many runs), the effect of
 * an injected weight version on the same inputs, the deterministic semantic
 * stage (equivalences are labelled, never hidden), weight validation, and
 * evidence citation. The database side — governance, per-dimension rows,
 * the regression that an old score keeps its version — is in
 * `tests/match-weights.test.ts`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getDeterministicEngine } from '../src/lib/providers';
import { combineScore } from '../src/lib/providers/ai/keywords';
import { canonicalSkill, compareTerms } from '../src/lib/matching/semantic';
import { BUILTIN_WEIGHTS, validateWeights } from '../src/lib/matching/weights';
import { citeEvidence, keywordOverlap } from '../src/lib/matching/pipeline';
import type { ResumeContent } from '../src/lib/types';
import type { JobContext } from '../src/lib/providers';

const RESUME: ResumeContent = {
  fullName: 'Pat Example',
  headline: 'Senior Data Analyst',
  email: 'pat@example.test',
  location: 'Toronto, ON',
  summary: 'Analyst with PostgreSQL, Python and Tableau; built dashboards and pipelines.',
  skills: ['PostgreSQL', 'Python', 'Tableau', 'dbt'],
  experience: [{ company: 'Northbridge', title: 'Senior Data Analyst', location: 'Toronto', startDate: '2021-01', endDate: 'Present', bullets: ['Built PostgreSQL reporting', 'Python pipelines'] }],
  education: [{ credential: 'BSc Statistics', institution: 'U of T', year: '2018' }],
  certifications: [],
  projects: [],
};
const JOB: JobContext = {
  title: 'Senior Data Analyst',
  company: 'Maple',
  location: 'Toronto, ON',
  description: 'We need Postgres, Python and Tableau. 3+ years of experience.',
  requirements: ['3+ years of experience', 'Strong SQL and Postgres'],
  skills: ['postgres', 'python', 'tableau'],
  workMode: 'hybrid',
};

describe('compatibility — semantic stage (deterministic equivalences, pgvector BLOCKED)', () => {
  it('maps spellings to a canonical form and labels a match made through the map as semantic', () => {
    assert.equal(canonicalSkill('Postgres'), 'postgresql');
    assert.equal(canonicalSkill('PostgreSQL'), 'postgresql');
    assert.equal(canonicalSkill('k8s'), 'kubernetes');
    assert.equal(canonicalSkill('tableau'), 'tableau', 'a term with no group is itself');
    const { matched, missing } = compareTerms(['postgres', 'python', 'kubernetes', 'looker'], ['PostgreSQL', 'python', 'K8s']);
    assert.deepEqual(matched.map((m) => [m.required, m.how]), [
      ['kubernetes', 'semantic'],
      ['postgres', 'semantic'],
      ['python', 'exact'],
    ]);
    assert.deepEqual(missing, ['looker']);
    assert.deepEqual(compareTerms(['python', 'python'], ['python']).matched.length, 1, 'duplicates collapse');
  });
});

describe('compatibility — deterministic stage with injected weights and the equivalence map', () => {
  const engine = getDeterministicEngine();
  it('is consistent: the same inputs give the same score and breakdown across many runs', async () => {
    const first = await engine.analyzeMatch(RESUME, JOB, { weights: BUILTIN_WEIGHTS, canonical: canonicalSkill });
    for (let i = 0; i < 25; i += 1) {
      const again = await engine.analyzeMatch(RESUME, JOB, { weights: BUILTIN_WEIGHTS, canonical: canonicalSkill });
      assert.deepEqual(again, first);
    }
  });
  it('the equivalence map lets "PostgreSQL" satisfy "postgres"; without it the posting term is missing', async () => {
    const withMap = await engine.analyzeMatch(RESUME, JOB, { canonical: canonicalSkill });
    const withoutMap = await engine.analyzeMatch(RESUME, JOB);
    assert.ok(withMap.matchedKeywords.map((k) => k.toLowerCase()).includes('postgres'), `matched: ${withMap.matchedKeywords}`);
    assert.ok(withoutMap.missingKeywords.map((k) => k.toLowerCase()).includes('postgres'), `missing: ${withoutMap.missingKeywords}`);
    assert.ok(withMap.breakdown.skills > withoutMap.breakdown.skills);
  });
  it('a different weight version changes the score for the same inputs, and the breakdown stays the same', async () => {
    const baseline = await engine.analyzeMatch(RESUME, JOB, { weights: BUILTIN_WEIGHTS, canonical: canonicalSkill });
    const locationHeavy = await engine.analyzeMatch(RESUME, JOB, { weights: { skills: 0.1, keywords: 0.1, experience: 0.1, seniority: 0.1, location: 0.6 }, canonical: canonicalSkill });
    assert.deepEqual(locationHeavy.breakdown, baseline.breakdown, 'dimensions are measured, not weighted');
    assert.notEqual(locationHeavy.matchScore, baseline.matchScore);
    const noWeights = await engine.analyzeMatch(RESUME, JOB, { canonical: canonicalSkill });
    assert.equal(noWeights.matchScore, baseline.matchScore, 'absent weights are the built-in baseline');
  });
  it('the score is the one combination rule applied to the breakdown, so the pipeline can apply it on every route', async () => {
    const a = await engine.analyzeMatch(RESUME, JOB, { weights: BUILTIN_WEIGHTS, canonical: canonicalSkill });
    assert.equal(a.matchScore, combineScore(a.breakdown, BUILTIN_WEIGHTS));
    const w = { skills: 0.1, keywords: 0.1, experience: 0.1, seniority: 0.1, location: 0.6 };
    const b = await engine.analyzeMatch(RESUME, JOB, { weights: w, canonical: canonicalSkill });
    assert.equal(b.matchScore, combineScore(b.breakdown, w));
  });
});

describe('compatibility — requirement extraction is consumed, and both sides are canonicalised (Stage 08 review)', () => {
  const engine = getDeterministicEngine();
  // The description spells it "PostgreSQL", the skills field "postgres": one requirement, not two.
  const posting: JobContext = { title: 'Data Analyst', company: 'Maple', location: 'Toronto, ON', description: 'We need PostgreSQL and Python.', requirements: [], skills: ['postgres', 'python', 'looker'], workMode: 'hybrid' };
  it('deduplicates the posting\'s skills under the equivalence map, so a spelling variant never counts twice', async () => {
    const a = await engine.analyzeMatch(RESUME, posting, { canonical: canonicalSkill });
    assert.equal(a.matchedKeywords.filter((k) => /postgres/i.test(k)).length, 1, `matched: ${a.matchedKeywords}`);
    assert.equal(a.missingKeywords.filter((k) => /postgres/i.test(k)).length, 0, `missing: ${a.missingKeywords}`);
    assert.match(a.rationale, /You match 2 of 3 named skills/);
    assert.equal(a.breakdown.skills, 67);
  });
  it('a nice-to-have from the canonical job costs half a requirement; a certification requirement counts as a requirement', async () => {
    const preferred = await engine.analyzeMatch(RESUME, posting, { canonical: canonicalSkill, requirements: { required: ['python', 'postgres'], preferred: ['looker'], certifications: [], experienceYearsMin: null } });
    assert.equal(preferred.breakdown.skills, 80, 'earned 2 of 2.5');
    assert.deepEqual(preferred.missingKeywords, ['Looker']);
    const withCpa = await engine.analyzeMatch(RESUME, posting, { canonical: canonicalSkill, requirements: { required: ['python', 'postgres'], preferred: ['looker'], certifications: ['cpa'], experienceYearsMin: null } });
    assert.equal(withCpa.breakdown.skills, 57, 'earned 2 of 3.5 — the missing credential counts in full');
    assert.ok(withCpa.missingKeywords.includes('CPA'));
    const holdsCpa = await engine.analyzeMatch({ ...RESUME, certifications: ['CPA'] }, posting, { canonical: canonicalSkill, requirements: { required: ['python', 'postgres'], preferred: ['looker'], certifications: ['cpa'], experienceYearsMin: null } });
    assert.equal(holdsCpa.breakdown.skills, 86, 'earned 3 of 3.5');
  });
  it('the canonical job\'s extracted minimum years replaces the regex over the requirements text', async () => {
    const none = await engine.analyzeMatch(RESUME, posting, { canonical: canonicalSkill });
    assert.equal(none.breakdown.experience, 78, 'no stated requirement anywhere');
    const ten = await engine.analyzeMatch(RESUME, posting, { canonical: canonicalSkill, requirements: { required: [], preferred: [], certifications: [], experienceYearsMin: 10 } });
    assert.ok(ten.breakdown.experience < none.breakdown.experience, `${ten.breakdown.experience} < ${none.breakdown.experience}`);
    assert.match(ten.rationale, /asks for 10 years/);
  });
});

describe('compatibility — the keyword dimension decomposes into the tokens it measures', () => {
  it('lists the posting\'s signal tokens the résumé contains and those it does not, lexically', () => {
    const d = keywordOverlap(JOB, RESUME);
    assert.deepEqual(d.overlap, ['analyst', 'data', 'python', 'senior', 'tableau']);
    assert.deepEqual(d.absent, ['postgres', 'sql'], 'density is lexical: "postgresql" on the résumé does not contain the token "sql"');
    assert.equal(d.total, 7);
  });
});

describe('compatibility — weights validation and evidence citation', () => {
  it('weights must name every dimension, each within [0, 1], summing to 1', () => {
    assert.equal(validateWeights(BUILTIN_WEIGHTS), null);
    assert.match(validateWeights({ skills: 1 }) ?? '', /exactly/);
    assert.match(validateWeights({ ...BUILTIN_WEIGHTS, skills: 0.5 }) ?? '', /sum to 1/);
    assert.match(validateWeights({ ...BUILTIN_WEIGHTS, skills: -0.1, keywords: 0.66 }) ?? '', /between 0 and 1/);
    assert.match(validateWeights({ ...BUILTIN_WEIGHTS, extra: 0 }) ?? '', /exactly/);
    assert.equal(validateWeights({ skills: 0.2, keywords: 0.2, experience: 0.2, seniority: 0.2, location: 0.2 }), null);
  });
  it('cites the approved claims whose text supports a matched term, under the equivalence map, optionally by kind', () => {
    const entries = [
      { id: 'e1', kind: 'skill', claim: 'Skill: PostgreSQL' },
      { id: 'e2', kind: 'employment', claim: 'Senior Data Analyst at Northbridge, 2021-01 to present' },
      { id: 'e3', kind: 'achievement', claim: 'Cut reporting latency with Python pipelines' },
      { id: 'e4', kind: 'skill', claim: 'Skill: Looker' },
    ];
    assert.deepEqual(citeEvidence(entries, ['postgres']), ['e1'], 'postgres cites the PostgreSQL claim through the map');
    assert.deepEqual(citeEvidence(entries, ['python']), ['e3']);
    assert.deepEqual(citeEvidence(entries, ['python'], ['skill']), [], 'kind filter');
    assert.deepEqual(citeEvidence(entries, ['tableau']), []);
    assert.deepEqual(citeEvidence(entries, []), []);
  });
  it('never cites a claim on a bare word: an ambiguous vocabulary term needs a skill claim or a proper-noun spelling', () => {
    const entries = [
      { id: 'g1', kind: 'achievement', claim: 'Helped the team go live with new reporting' },
      { id: 'g2', kind: 'skill', claim: 'Skill: Go' },
      { id: 'g3', kind: 'achievement', claim: 'Rewrote billing services in Go' },
      { id: 'g4', kind: 'achievement', claim: 'Migrated pipelines to golang' },
      { id: 'g5', kind: 'achievement', claim: 'Reduced Google Ads spend' },
      { id: 'g6', kind: 'achievement', claim: 'Built dashboards for finance in R' },
      { id: 'g7', kind: 'achievement', claim: 'Rest days were rostered fairly' },
    ];
    assert.deepEqual(citeEvidence(entries, ['go']), ['g2', 'g3', 'g4']);
    assert.deepEqual(citeEvidence(entries, ['golang']), ['g2', 'g3', 'g4'], 'the same under the map');
    assert.deepEqual(citeEvidence(entries, ['r']), ['g6']);
    assert.deepEqual(citeEvidence(entries, ['rest']), [], 'a sentence-initial common word without a skill claim is not evidence of REST');
    // Keyword-density tokens: whole words only, never stop words or fragments.
    const k = [{ id: 'k1', kind: 'achievement', claim: 'Built dashboards for finance' }];
    assert.deepEqual(citeEvidence(k, ['dashboards']), ['k1']);
    assert.deepEqual(citeEvidence(k, ['dash']), []);
    assert.deepEqual(citeEvidence(k, ['for', 'the']), []);
  });
});
