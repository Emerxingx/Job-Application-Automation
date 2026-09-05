/**
 * Stage 17 (ADR-0032) - the case-manager copilot, pure, and the static
 * guards that keep RESTRICTED case data off every recommendation, matching
 * and AI path.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { COPILOT_VERSION, assessSignals, type ClientSignals } from '../src/lib/cases/copilot';
import { RESTRICTED_KEYS } from '../src/lib/ai/restricted-fields';
import { caseRoleOf, canOpenCase, canWriteCase, canManageCaseload } from '../src/lib/cases/roles';

const quiet: ClientSignals = {
  daysSinceActivity: 3,
  applications: { total: 4, submitted: 3, responded: 1, interviews: 1, offers: 0, submitted30d: 2 },
  eligibility: { evaluated: 10, failsByRule: {}, certificationsNamed: [] },
  matching: { scored: 8, seniorityLow: 1, skillsLow: 1, keywordsLow: 1, missingSkills: [] },
  profile: { hasResume: true, skillsCount: 12, hasTargetTitles: true, locationsCount: 2, relocation: 'open' },
  market: { targetOccupationSet: true, postingsOpen: 12 },
};

describe('case copilot - patterns from non-restricted signals (pure)', () => {
  it('a healthy search draws no recommendation; the version is stated', () => {
    assert.deepEqual(assessSignals(quiet), []);
    assert.match(COPILOT_VERSION, /^\d{4}-\d{2}-\d{2}\.\d+$/);
  });

  it('each pattern fires on its threshold with the numbers that triggered it, and the list is deterministic', () => {
    const s: ClientSignals = {
      daysSinceActivity: 50,
      applications: { total: 30, submitted: 25, responded: 1, interviews: 0, offers: 0, submitted30d: 10 },
      eligibility: { evaluated: 20, failsByRule: { location: 9, licensure: 3 }, certificationsNamed: ['CPA designation', 'RN licence'] },
      matching: { scored: 10, seniorityLow: 6, skillsLow: 7, keywordsLow: 8, missingSkills: ['python', 'sql', 'aws', 'docker', 'kubernetes', 'go'] },
      profile: { hasResume: true, skillsCount: 3, hasTargetTitles: false, locationsCount: 1, relocation: 'no' },
      market: { targetOccupationSet: true, postingsOpen: 1 },
    };
    const r = assessSignals(s);
    assert.deepEqual(
      r.map((x) => [x.pattern, x.severity]),
      [
        ['inactive', 'high'],
        ['poor_response_rate', 'high'],
        ['unrealistic_seniority', 'attention'],
        ['missing_qualifications', 'attention'],
        ['geographic_constraints', 'high'],
        ['resume_problems', 'attention'],
        ['weak_demand', 'info'],
        ['certification_gaps', 'attention'],
      ],
    );
    assert.deepEqual(r.find((x) => x.pattern === 'poor_response_rate')!.detail, { submitted: 25, responded: 1, rate: 4 });
    assert.deepEqual(r.find((x) => x.pattern === 'missing_qualifications')!.detail.missingSkills, ['python', 'sql', 'aws', 'docker', 'kubernetes'], 'capped at five');
    assert.deepEqual(assessSignals(s), r);
    // below the samples nothing is claimed
    const thin = { ...s, applications: { ...s.applications, submitted: 7, responded: 0 }, matching: { ...s.matching, scored: 4 }, eligibility: { evaluated: 2, failsByRule: { location: 2, licensure: 1 }, certificationsNamed: [] } };
    const t = assessSignals(thin).map((x) => x.pattern);
    assert.ok(!t.includes('poor_response_rate') && !t.includes('unrealistic_seniority') && !t.includes('missing_qualifications') && !t.includes('geographic_constraints') && !t.includes('certification_gaps'));
    // no résumé is high on its own; no target only when neither the profile nor the case says
    assert.equal(assessSignals({ ...quiet, profile: { ...quiet.profile, hasResume: false } }).find((x) => x.pattern === 'resume_problems')?.severity, 'high');
    assert.ok(assessSignals({ ...quiet, profile: { ...quiet.profile, hasTargetTitles: false }, market: { targetOccupationSet: false, postingsOpen: null } }).some((x) => x.pattern === 'no_target'));
    assert.ok(!assessSignals({ ...quiet, profile: { ...quiet.profile, hasTargetTitles: false } }).some((x) => x.pattern === 'no_target'));
  });

  it('suggested actions recommend and never decide: no action text claims to have changed anything', () => {
    const s: ClientSignals = { ...quiet, daysSinceActivity: 60, applications: { ...quiet.applications, submitted: 30, responded: 0 }, profile: { ...quiet.profile, hasResume: false } };
    for (const r of assessSignals(s)) {
      assert.ok(!/\b(applied|submitted on|updated the|changed the|we have|has been (?:sent|applied|updated))\b/i.test(r.suggestedAction), r.suggestedAction);
    }
  });
});

describe('case roles - a named set over the ladder, failing closed', () => {
  it('owner and admin are admin; the service role otherwise; null or unknown is viewer', () => {
    assert.equal(caseRoleOf({ role: 'owner', serviceRole: null }), 'admin');
    assert.equal(caseRoleOf({ role: 'admin', serviceRole: 'viewer' }), 'admin');
    assert.equal(caseRoleOf({ role: 'member', serviceRole: 'supervisor' }), 'supervisor');
    assert.equal(caseRoleOf({ role: 'member', serviceRole: 'case_manager' }), 'case_manager');
    assert.equal(caseRoleOf({ role: 'member', serviceRole: null }), 'viewer');
    assert.equal(caseRoleOf({ role: 'member', serviceRole: 'director' }), 'viewer');
    assert.equal(caseRoleOf({ role: 'chief', serviceRole: 'supervisor' }), 'supervisor', 'an unknown ladder rung is not admin');
  });
  it('a case manager opens and writes only an assigned case; a supervisor reads all and writes none; a viewer opens nothing', () => {
    const mine = { caseManagerId: 'cm' };
    const theirs = { caseManagerId: 'other' };
    assert.equal(canOpenCase('case_manager', mine, 'cm'), true);
    assert.equal(canOpenCase('case_manager', theirs, 'cm'), false);
    assert.equal(canWriteCase('case_manager', theirs, 'cm'), false);
    assert.equal(canOpenCase('supervisor', theirs, 'cm'), true);
    assert.equal(canWriteCase('supervisor', theirs, 'cm'), false);
    assert.equal(canOpenCase('viewer', mine, 'cm'), false);
    assert.equal(canWriteCase('admin', theirs, 'cm'), true);
    assert.equal(canManageCaseload('case_manager'), false);
    assert.equal(canManageCaseload('supervisor'), true);
  });
});

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* files(full);
    else if (/\.(ts|tsx)$/.test(entry)) yield full;
  }
}

describe('case data - static: RESTRICTED rows reach no recommendation, matching, analytics or AI path', () => {
  const root = path.resolve(__dirname, '..');
  const RESTRICTED_MODELS = /\b(caseNote|caseAssessment|CaseNote|CaseAssessment)\b|\.barriers\b/;

  it('the copilot and the client view never touch a case note, an assessment or a barrier, and never import a model provider', () => {
    for (const f of ['src/lib/cases/copilot.ts', 'src/lib/cases/client-view.ts', 'src/lib/cases/copilot-run.ts']) {
      const text = readFileSync(path.join(root, f), 'utf8');
      assert.ok(!RESTRICTED_MODELS.test(text), `${f} references a RESTRICTED case row`);
      assert.ok(!/@anthropic-ai\/sdk|lib\/ai\/gateway|lib\/ai\/providers|lib\/sensitive/.test(text), `${f} reaches a provider or the sensitive path`);
    }
  });

  it('nothing under matching, eligibility, analytics, career or the AI gateway names a case table', () => {
    const offenders: string[] = [];
    for (const dir of ['src/lib/matching', 'src/lib/eligibility', 'src/lib/analytics', 'src/lib/career', 'src/lib/ai']) {
      for (const f of files(path.join(root, dir))) {
        const rel = path.relative(root, f);
        if (rel === 'src/lib/ai/restricted-fields.ts') continue; // it names the KEYS in order to refuse them
        if (/\b(case|caseNote|caseAssessment|caseRecommendation|caseTask)\.(findMany|findFirst|findUnique|create|update|count|aggregate|groupBy)\b|\bCaseNote\b|\bCaseAssessment\b/.test(readFileSync(f, 'utf8'))) offenders.push(rel);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it('the AI gateway refuses a payload carrying a case note, an assessment or barriers', () => {
    for (const k of ['caseNote', 'case_note', 'caseNotes', 'caseAssessment', 'caseAssessments', 'caseBarriers']) assert.ok((RESTRICTED_KEYS as readonly string[]).includes(k), k);
    for (const k of ['assessments', 'assessment', 'barriers']) assert.ok(!(RESTRICTED_KEYS as readonly string[]).includes(k), `${k} is a Stage 10 folder count, not a RESTRICTED key`);
  });
});
