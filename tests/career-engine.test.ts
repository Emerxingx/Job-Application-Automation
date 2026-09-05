/**
 * Stage 16 (ADR-0031) - the transition engine and the counterfactual, pure.
 * No database: the graph nodes are built by hand, so every assertion is
 * about the rule, not the fixture. Plus a static guard: nothing under
 * src/lib/career reaches a model provider or the AI gateway - the engine is
 * deterministic by construction.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ENGINE_VERSION, HONESTY, analyseTransition, difficultyBand, holdsCredential, holdsSkill, normalizeTerm, offeringCounterfactual, type CandidateFacts, type OccupationNode, type OfferingNode, type TransitionInput } from '../src/lib/career/engine';
import { credentialCounterfactual } from '../src/lib/career/counterfactual';
import { WITHDRAWN_TITLE, withdrawFromAnalysis } from '../src/lib/career/withdraw';
import { NOT_YET_HELD as ELIGIBILITY_NOT_YET_HELD, type CandidateEligibility, type JobEligibilityFacts } from '../src/lib/eligibility/engine';
import { NOT_YET_HELD as CAREER_NOT_YET_HELD } from '../src/lib/career/engine';

const P = { datasetKey: 'learning-fixture', attribution: 'Fixture attribution' };
const skill = (id: string, name: string, importance: number | null = null) => ({ skillId: id, name, normalizedName: normalizeTerm(name), importance, level: null });

const target: OccupationNode = {
  id: 'occ_ds',
  title: 'Data scientists',
  teer: 1,
  provenance: { datasetKey: 'noc-2021', attribution: 'NOC 2021' },
  skills: [skill('s_py', 'Python', 5), skill('s_sql', 'SQL', 5), skill('s_stats', 'Statistics', 4), skill('s_ml', 'Machine learning', 4), skill('s_viz', 'Data visualization', 3), skill('s_pipe', 'Data pipelines', 2)],
  credentials: [
    { credentialId: 'c_msc', name: 'MSc Data Science', kind: 'degree', requirement: 'preferred', regulated: false, recognition: 'unverified', spellings: ['msc data science'], provenance: P },
    { credentialId: 'c_aws', name: 'AWS Certified Data Analytics - Specialty', kind: 'certification', requirement: 'preferred', regulated: false, recognition: 'vendor', spellings: ['aws certified data analytics'], provenance: P },
  ],
};
const current: OccupationNode = { id: 'occ_dba', title: 'Database analysts', teer: 1, provenance: null, skills: [skill('s_sql', 'SQL', 5), skill('s_pipe', 'Data pipelines', 4)], credentials: [] };
const candidate: CandidateFacts = { skills: [{ skillId: 's_sql', normalizedName: 'sql', proficiency: null, yearsUsed: 6 }, { skillId: null, normalizedName: 'data pipelines', proficiency: null, yearsUsed: 2 }], certifications: [] };
const offerings: OfferingNode[] = [
  { id: 'o_msc', title: 'MSc in Data Science', providerName: 'Fixture University', deliveryMode: 'in_person', durationWeeks: 52, durationHours: null, costCents: 1800000, currency: 'CAD', credentialId: 'c_msc', skillIds: ['s_stats', 's_ml', 's_py', 's_sql', 's_viz'], provenance: P },
  { id: 'o_python', title: 'Python for data work', providerName: 'Fixture Academy', deliveryMode: 'online', durationWeeks: 6, durationHours: 40, costCents: 49900, currency: 'CAD', credentialId: null, skillIds: ['s_py', 's_pipe'], provenance: P },
  { id: 'o_aws', title: 'AWS data analytics prep', providerName: 'Fixture Academy', deliveryMode: 'online', durationWeeks: 4, durationHours: 30, costCents: 29900, currency: 'CAD', credentialId: 'c_aws', skillIds: ['s_pipe', 's_viz'], provenance: P },
];
const base: TransitionInput = { current, target, candidate, offerings, market: { postingsOpen: 3, postings30d: 1 }, bridges: [], now: new Date('2026-09-05T12:00:00Z') };

describe('career engine - transferable skills, gaps, difficulty, pathway, provenance (pure)', () => {
  it('holds a skill by id or normalised name and a credential by any whole-word spelling', () => {
    assert.equal(holdsSkill(candidate, skill('s_sql', 'SQL')), true);
    assert.equal(holdsSkill(candidate, skill('s_other', 'Data Pipelines')), true, 'by normalised name when the profile row has no id');
    assert.equal(holdsSkill(candidate, skill('s_py', 'Python')), false);
    const cpa = { name: 'Chartered Professional Accountant (CPA)', spellings: ['cpa', 'chartered professional accountant'] };
    assert.equal(holdsCredential({ skills: [], certifications: ['CPA, Ontario 2021'] }, cpa), true);
    assert.equal(holdsCredential({ skills: [], certifications: ['Chartered Professional Accountant'] }, cpa), true);
    assert.equal(holdsCredential({ skills: [], certifications: ['CPAP therapy certificate'] }, cpa), false, 'a substring is not a spelling');
    assert.equal(holdsCredential({ skills: [], certifications: [] }, cpa), false);
    // review M5: a certification that says it is not yet held is not held
    for (const notYet of ['CPA (in progress)', 'CPA candidate', 'Working towards CPA', 'CPA exam booked', 'Studying for the CPA']) {
      assert.equal(holdsCredential({ skills: [], certifications: [notYet] }, cpa), false, notYet);
    }
    assert.equal(String(CAREER_NOT_YET_HELD), String(ELIGIBILITY_NOT_YET_HELD), 'the two engines share the vocabulary');
    // review L7: the same normalisation as the eligibility engine, so a dotted designation is one term in both
    const peng = { name: 'P.Eng.', spellings: ['p eng', 'professional engineer'] };
    assert.equal(holdsCredential({ skills: [], certifications: ['P. Eng'] }, peng), true);
    assert.equal(holdsCredential({ skills: [], certifications: ['P.Eng. (Ontario)'] }, peng), true);
  });

  it('when offerings are WITHHELD the analysis says so: coverage is null, the pathway has a withheld step and never "nothing covers this" (review H1)', () => {
    const a = analyseTransition({ ...base, offerings: [], offeringsWithheld: true });
    assert.equal(a.offeringsWithheld, true);
    assert.ok(a.gaps.skills.every((g) => g.coveredBy === null));
    assert.ok(a.gaps.credentials.every((g) => g.coveredBy === null));
    const withheld = a.pathway.filter((p) => p.kind === 'withheld');
    assert.equal(withheld.length, 1);
    assert.match(withheld[0]!.title, /not shown under your plan/);
    assert.ok(!a.pathway.some((p) => /No licensed offering/.test(p.title)));
    assert.deepEqual(withheld[0]!.closesSkillIds, ['s_py', 's_ml', 's_stats', 's_viz']);
    const shown = analyseTransition({ ...base, offerings: [] });
    assert.equal(shown.offeringsWithheld, false);
    assert.ok(shown.pathway.some((p) => /No licensed offering/.test(p.title)), 'with nothing withheld an empty graph is said to be empty');
  });

  it('withdrawing a dataset from a stored analysis replaces its steps and coverage and lists the key; a second withdrawal is a no-op (review M4)', () => {
    const a = analyseTransition(base);
    const r = withdrawFromAnalysis(a, 'learning-fixture', new Set(['o_msc', 'o_python', 'o_aws']));
    assert.equal(r.changed, true);
    assert.deepEqual(r.analysis.withdrawn, ['learning-fixture']);
    assert.ok(r.analysis.pathway.filter((p) => p.kind === 'credential').every((p) => p.title === WITHDRAWN_TITLE && p.offeringId === null && p.provenance === null));
    assert.ok(r.analysis.gaps.skills.every((g) => g.coveredBy !== null && g.coveredBy.length === 0));
    assert.ok(!r.analysis.provenance.some((p) => p.datasetKey === 'learning-fixture'));
    assert.ok(r.analysis.provenance.some((p) => p.datasetKey === 'noc-2021'), 'another dataset\'s provenance stays');
    const again = withdrawFromAnalysis(r.analysis, 'learning-fixture', new Set());
    assert.equal(again.changed, false);
    assert.equal(withdrawFromAnalysis(a, 'nothing', new Set()).changed, false);
  });

  it('separates what transfers from what is missing, orders gaps by importance, prices credentials by requirement, and bands the score', () => {
    const a = analyseTransition(base);
    assert.equal(a.engineVersion, ENGINE_VERSION);
    assert.deepEqual(a.transferable.map((s) => s.skillId), ['s_sql', 's_pipe']);
    assert.deepEqual(a.gaps.skills.map((s) => s.name), ['Python', 'Machine learning', 'Statistics', 'Data visualization'], 'importance desc, then name');
    assert.deepEqual(a.gaps.skills.find((s) => s.skillId === 's_py')!.coveredBy, ['o_msc', 'o_python']);
    assert.deepEqual(a.gaps.credentials.map((c) => c.credentialId), ['c_aws', 'c_msc'], 'equal points: by name');
    // 20 (py) + 16 (ml) + 16 (stats) + 12 (viz) + 5 + 5 (two preferred credentials) - 5 (lateral, same TEER, no bridge) = 69
    assert.equal(a.difficulty.score, 69);
    assert.equal(a.difficulty.band, 'high');
    assert.ok(a.difficulty.factors.some((f) => f.factor === 'lateral' && f.points === -5));
    assert.equal(difficultyBand(0), 'low');
    assert.equal(difficultyBand(59), 'moderate');
    assert.equal(a.market.note, '3 open postings held here, 1 posted in the last 30 days.');
    assert.deepEqual(a.honesty, [...HONESTY]);
  });

  it('builds the pathway: credentials first (via an offering when one leads to it), then a greedy set cover of the remaining skill gaps, then the uncovered rest, then bridges - every step with provenance', () => {
    const a = analyseTransition({ ...base, bridges: [{ occupationId: 'occ_mid', title: 'Data analysts', kind: 'progression', provenance: { datasetKey: 'noc-2021', attribution: 'NOC 2021' } }] });
    assert.deepEqual(a.pathway.map((p) => [p.order, p.kind, p.offeringId, p.credentialId, p.occupationId]), [
      [1, 'credential', 'o_aws', 'c_aws', null],
      [2, 'credential', 'o_msc', 'c_msc', null],
      // the MSc already covers Python, ML, statistics and visualisation, so nothing is left for the set cover
      [3, 'experience', null, null, 'occ_mid'],
    ]);
    assert.ok(a.pathway.every((p) => p.provenance !== null));
    assert.deepEqual(a.provenance.map((p) => p.datasetKey), ['noc-2021', 'learning-fixture']);
    // without the MSc offering the set cover picks Python (2 gaps: py) then nothing covers ML/statistics -> an honest "not covered" step
    const b = analyseTransition({ ...base, offerings: offerings.filter((o) => o.id !== 'o_msc') });
    const kinds = b.pathway.map((p) => [p.kind, p.offeringId]);
    assert.deepEqual(kinds[0], ['credential', 'o_aws']);
    assert.deepEqual(kinds[1], ['credential', null], 'the MSc has no offering: the step names the credential alone');
    assert.deepEqual(kinds[2], ['learning', 'o_python']);
    const open = b.pathway.at(-1)!;
    assert.equal(open.offeringId, null);
    assert.match(open.title, /No licensed offering in the graph covers Machine learning, Statistics yet/);
    assert.deepEqual(open.closesSkillIds, ['s_ml', 's_stats']);
    assert.equal(open.provenance, null, 'nothing is attributed to a dataset that did not say it');
  });

  it('is deterministic and never invents: same input, same output; no offerings, no dataset -> no pathway offerings and a plain note', () => {
    assert.deepEqual(analyseTransition(base), analyseTransition({ ...base }));
    const bare = analyseTransition({ current: null, target: { ...target, credentials: [] }, candidate: { skills: [], certifications: [] }, offerings: [], market: { postingsOpen: 0, postings30d: 0 }, bridges: [], now: base.now });
    assert.equal(bare.transferable.length, 0);
    assert.equal(bare.pathway.length, 1);
    assert.equal(bare.pathway[0]!.offeringId, null);
    assert.equal(bare.market.note, 'No open postings for this occupation in this deployment right now.');
    assert.ok(!bare.difficulty.factors.some((f) => f.factor === 'lateral'), 'no current occupation, no lateral discount');
  });

  it('an offering counterfactual closes exactly the gaps it states it teaches and lowers the difficulty by those points', () => {
    const r = offeringCounterfactual(base, offerings.find((o) => o.id === 'o_python')!);
    assert.equal(r.skillGapsClosed, 1, 'Python (data pipelines was already held)');
    assert.equal(r.difficultyDelta, -20);
    assert.equal(r.after.gaps.credentials.length, 2, 'a course with no credential grants none');
    const msc = offeringCounterfactual(base, offerings.find((o) => o.id === 'o_msc')!);
    assert.equal(msc.skillGapsClosed, 4);
    assert.deepEqual(msc.after.gaps.credentials.map((c) => c.credentialId), ['c_aws'], 'the MSc credential is now held');
  });
});

describe('career counterfactual - a completed credential changes eligibility (pure, Stage 07 engine before and after)', () => {
  const cand: CandidateEligibility = {
    workAuth: { country: 'CA', status: 'citizen', permitExpiresAt: null, sponsorshipNeeded: false },
    preferences: { countries: ['CA'], locations: [], relocation: 'open' },
    certifications: [],
    languages: [{ language: 'en', proficiency: 'native' }],
  };
  const job: JobEligibilityFacts = {
    title: 'CPA - Senior Accountant',
    normalizedTitle: 'cpa senior accountant',
    read: true,
    country: 'CA',
    location: 'Toronto, ON',
    postalRegion: 'CA-ON/toronto',
    workMode: 'onsite',
    workAuthorization: null,
    sponsorship: 'unknown',
    certificationRequirements: ['CPA'],
    languageRequirements: [],
  };

  it('a licensed designation the title demands: ineligible before, eligible after, and exactly the licensure rule moved', () => {
    const r = credentialCounterfactual(cand, job, { name: 'Chartered Professional Accountant (CPA)', spellings: ['cpa', 'chartered professional accountant'] }, new Date('2026-09-05'));
    assert.equal(r.outcomeBefore, 'ineligible');
    assert.equal(r.outcomeAfter, 'eligible');
    assert.equal(r.materiallyChanged, true);
    assert.deepEqual(r.changes.map((c) => [c.rule, c.from, c.to]), [['licensure', 'fail', 'pass']]);
    assert.ok(r.after.rules.every((rule) => rule.status !== 'fail'));
  });

  it('a credential the posting does not ask for changes nothing, and says so', () => {
    const r = credentialCounterfactual(cand, job, { name: 'AWS Certified Data Analytics - Specialty', spellings: ['aws certified data analytics'] }, new Date('2026-09-05'));
    assert.equal(r.materiallyChanged, false);
    assert.deepEqual(r.changes, []);
    assert.equal(r.outcomeAfter, 'ineligible', 'still ineligible: the CPA is still missing');
  });
});

describe('career - static: deterministic by construction', () => {
  it('nothing under src/lib/career imports the AI gateway, a provider SDK or the sensitive path', () => {
    const dir = path.resolve(__dirname, '..', 'src', 'lib', 'career');
    const offenders: string[] = [];
    for (const f of readdirSync(dir)) {
      const text = readFileSync(path.join(dir, f), 'utf8');
      if (/@anthropic-ai\/sdk|lib\/ai\/gateway|lib\/ai\/providers|lib\/sensitive|lib\/mailbox/.test(text)) offenders.push(f);
    }
    assert.deepEqual(offenders, []);
  });
});
