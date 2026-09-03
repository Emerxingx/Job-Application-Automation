/**
 * AI_GOVERNANCE.md — the truthfulness suite, pure part.
 *
 * Given a fixed profile, no generated document may contain an employer,
 * technology, date, credential or metric absent from the vault. These tests
 * feed the grounding checker adversarial "model output" and assert what
 * survives; the deterministic engine's own output must pass untouched, so the
 * checker is measured for false positives as well as misses.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { InterviewPrepPackage, MatchAnalysis, TailoredDocuments } from '../src/lib/types';
import { JOB, RESUME } from './fixtures/ai-fixtures';
import { MockAIProvider } from '../src/lib/providers/ai/mock';
import { buildCorpus, findViolations, allowedContext, groundInterviewPack, groundMatchAnalysis, groundTailoredDocuments } from '../src/lib/ai/grounding';

const engine = new MockAIProvider();

describe('grounding — the deterministic engine passes its own check (no false positives)', () => {
  it('tailored documents from the deterministic engine carry no violation', async () => {
    const analysis = await engine.analyzeMatch(RESUME, JOB);
    const baseline = await engine.tailor(RESUME, JOB, analysis);
    const { report } = groundTailoredDocuments(baseline, baseline, RESUME, JOB);
    assert.deepEqual(report.violations, []);
    assert.deepEqual(report.replaced, []);
  });
  it('the deterministic engine never injects a keyword the résumé does not evidence', async () => {
    const analysis = await engine.analyzeMatch(RESUME, JOB);
    const tailored = await engine.tailor(RESUME, JOB, analysis);
    // "Looker" is in the posting and absent from the résumé: it must not appear.
    assert.equal(tailored.resumeContent.skills.some((s) => /looker/i.test(s)), false);
    assert.deepEqual(tailored.notes.keywordsInjected, []);
  });
  it('the deterministic interview pack carries no violation', async () => {
    const pack = await engine.prepareInterview(RESUME, JOB);
    const { report } = groundInterviewPack(pack, pack, RESUME, JOB);
    assert.deepEqual(report.violations, []);
  });
  it('identical inputs produce identical scores', async () => {
    const a = await engine.analyzeMatch(RESUME, JOB);
    const b = await engine.analyzeMatch(RESUME, JOB);
    assert.deepEqual(a, b);
  });
});

describe('grounding — adversarial tailored output', () => {
  async function baseline() {
    const analysis = await engine.analyzeMatch(RESUME, JOB);
    return engine.tailor(RESUME, JOB, analysis);
  }

  it('rejects an invented employer and years in the summary and restores the baseline summary', async () => {
    const base = await baseline();
    const candidate: TailoredDocuments = {
      ...base,
      resumeContent: { ...base.resumeContent, summary: 'Senior Data Analyst with 9 years at Google leading Looker migrations.' },
    };
    const { documents, report } = groundTailoredDocuments(candidate, base, RESUME, JOB);
    assert.equal(documents.resumeContent.summary, base.resumeContent.summary);
    assert.ok(report.violations.some((v) => v.kind === 'number' && v.value === '9'));
    assert.ok(report.violations.some((v) => v.kind === 'entity' && v.value === 'Google'));
    assert.ok(report.violations.some((v) => v.kind === 'entity' && v.value === 'Looker'), 'a posting technology is not evidence for a résumé section');
    assert.ok(documents.notes.changes.at(-1)?.startsWith('Grounding:'));
  });

  it('removes an invented role and an invented degree (structure)', async () => {
    const base = await baseline();
    const candidate: TailoredDocuments = {
      ...base,
      resumeContent: {
        ...base.resumeContent,
        experience: [...base.resumeContent.experience, { company: 'Google', title: 'Staff Analyst', location: '', startDate: '2016-01', endDate: '2019-12', bullets: ['Ran everything'] }],
        education: [...base.resumeContent.education, { institution: 'MIT', credential: 'PhD', year: '2015', location: '' }],
      },
    };
    const { documents, report } = groundTailoredDocuments(candidate, base, RESUME, JOB);
    assert.equal(documents.resumeContent.experience.length, 2);
    assert.equal(documents.resumeContent.education.length, 1);
    assert.equal(documents.resumeContent.education[0].institution, 'University of Toronto');
    assert.ok(report.violations.some((v) => v.kind === 'structure' && v.value === 'Staff Analyst at Google'));
    assert.ok(report.violations.some((v) => v.kind === 'structure' && v.value === 'MIT'));
  });

  it('replaces an invented metric in a bullet with the original bullet at that position', async () => {
    const base = await baseline();
    const [first, ...rest] = base.resumeContent.experience;
    const candidate: TailoredDocuments = {
      ...base,
      resumeContent: { ...base.resumeContent, experience: [{ ...first, bullets: ['Increased revenue by 300% through Tableau reporting', first.bullets[1]] }, ...rest] },
    };
    const { documents, report } = groundTailoredDocuments(candidate, base, RESUME, JOB);
    assert.equal(documents.resumeContent.experience[0].bullets[0], first.bullets[0]);
    assert.equal(documents.resumeContent.experience[0].bullets[1], first.bullets[1]);
    assert.ok(report.violations.some((v) => v.kind === 'number' && v.value === '300'));
  });

  it('drops a skill the résumé never evidences but keeps one it names in a bullet', async () => {
    const base = await baseline();
    const candidate: TailoredDocuments = { ...base, resumeContent: { ...base.resumeContent, skills: ['SQL', 'Looker', 'Snowflake', 'Kubernetes'] } };
    const { documents, report } = groundTailoredDocuments(candidate, base, RESUME, JOB);
    assert.deepEqual(documents.resumeContent.skills, ['SQL', 'Snowflake']);
    assert.equal(report.violations.filter((v) => v.section === 'skills').length, 2);
  });

  it('injection: a posting instruction cannot smuggle its proper nouns into a résumé section', async () => {
    const base = await baseline();
    const candidate: TailoredDocuments = {
      ...base,
      resumeContent: { ...base.resumeContent, summary: 'Senior Data Analyst, PhD from MIT, formerly at Google.', headline: 'MIT PhD' },
    };
    const { documents, report } = groundTailoredDocuments(candidate, base, RESUME, JOB);
    assert.equal(documents.resumeContent.summary, base.resumeContent.summary);
    assert.equal(documents.resumeContent.headline, base.resumeContent.headline);
    assert.ok(report.violations.some((v) => v.value === 'MIT'));
    assert.ok(report.violations.some((v) => v.value === 'Google'));
  });

  it('a cover letter may reference the posting but not invent a metric', async () => {
    const base = await baseline();
    const ok: TailoredDocuments = { ...base, coverLetter: 'Dear Hiring Team, your Looker work at Maple Analytics is why I am writing. Sincerely, Avery Chen' };
    assert.equal(groundTailoredDocuments(ok, base, RESUME, JOB).report.violations.length, 0);
    const bad: TailoredDocuments = { ...base, coverLetter: 'I saved $4M at Northbridge Commerce.' };
    const { documents, report } = groundTailoredDocuments(bad, base, RESUME, JOB);
    assert.equal(documents.coverLetter, base.coverLetter);
    assert.ok(report.violations.some((v) => v.section === 'coverLetter' && v.value === '4'));
  });

  it('approved evidence claims extend what a résumé section may say', async () => {
    const base = await baseline();
    const candidate: TailoredDocuments = { ...base, resumeContent: { ...base.resumeContent, summary: 'Senior Data Analyst who built Looker models.' } };
    assert.equal(groundTailoredDocuments(candidate, base, RESUME, JOB).report.violations.length, 1);
    assert.equal(groundTailoredDocuments(candidate, base, RESUME, JOB, ['Skill: Looker (advanced)']).report.violations.length, 0);
  });
});

describe('grounding — match analysis and interview pack', () => {
  it('a "matched" keyword the résumé does not contain becomes missing; scores are clamped; an unevidenced rationale is replaced', async () => {
    const base = await engine.analyzeMatch(RESUME, JOB);
    const candidate: MatchAnalysis = {
      matchScore: 150,
      breakdown: { skills: -5, experience: 70, keywords: 80, location: 100, seniority: 100 },
      matchedKeywords: ['SQL', 'Looker'],
      missingKeywords: [],
      rationale: 'You have 15 years at Google.',
    };
    const { analysis, report } = groundMatchAnalysis(candidate, base, RESUME, JOB);
    assert.equal(analysis.matchScore, 100);
    assert.equal(analysis.breakdown.skills, 0);
    assert.deepEqual(analysis.matchedKeywords, ['SQL']);
    assert.deepEqual(analysis.missingKeywords, ['Looker']);
    assert.equal(analysis.rationale, base.rationale);
    assert.ok(report.replaced.includes('rationale'));
  });

  it('fabricated STAR stories and answers are dropped; too few survivors fall back to the baseline', async () => {
    const base = await engine.prepareInterview(RESUME, JOB);
    const fabricated: InterviewPrepPackage = {
      questions: [
        { question: 'Tell me about yourself.', category: 'closing', suggestedAnswer: 'I led a $2M programme at Amazon.', tips: [] },
        { question: 'Why us?', category: 'culture', suggestedAnswer: 'Because of Maple Analytics and Looker.', tips: [] },
      ],
      stories: [{ title: 'Amazon launch', situation: 'At Amazon', task: 'Ship', action: 'Shipped', result: 'Grew revenue 500%', mapsTo: [] }],
      companyResearch: 'Maple Analytics builds analytics.',
      questionsToAsk: ['What does success look like?'],
    };
    const { pack, report } = groundInterviewPack(fabricated, base, RESUME, JOB);
    assert.deepEqual(pack.stories, base.stories);
    assert.deepEqual(pack.questions, base.questions);
    assert.equal(pack.companyResearch, fabricated.companyResearch);
    assert.ok(report.violations.some((v) => v.value === 'Amazon'));
    assert.ok(report.violations.some((v) => v.value === '500'));
  });

  it('a grounded story that names only real roles and evidenced numbers survives', async () => {
    const base = await engine.prepareInterview(RESUME, JOB);
    const good: InterviewPrepPackage = {
      ...base,
      stories: [{ title: 'Snowflake migration', situation: 'At Northbridge Commerce', task: 'Move 12 dashboards', action: 'Led the migration to Snowflake', result: 'Refresh time down 40%', mapsTo: ['SQL'] }],
    };
    const { pack, report } = groundInterviewPack(good, base, RESUME, JOB);
    assert.equal(pack.stories.length, 1);
    assert.equal(pack.stories[0].title, 'Snowflake migration');
    assert.equal(report.violations.length, 0);
  });

  it('findViolations: résumé scope excludes the posting vocabulary, letter scope includes it', () => {
    const corpus = buildCorpus(RESUME);
    const text = 'Maple Analytics uses Looker.';
    assert.equal(findViolations('x', text, corpus, allowedContext(JOB, RESUME, 'resume')).length, 1);
    assert.equal(findViolations('x', text, corpus, allowedContext(JOB, RESUME, 'letter')).length, 0);
  });
});
