/**
 * Stage 18 (ADR-0033) - the pure parts of talent acquisition: the submission
 * stage machine (no stage past consent without a granted disclosure; no
 * stage is ever left backwards), the employer roles as a named set over the
 * organisation ladder, and the static guards that keep employer code away
 * from the sensitive schema, the AI gateway, the mailbox and case records.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DISCLOSED_STAGES, STAGE_TRANSITIONS, SUBMISSION_STAGES, canTransition, isSubmissionStage, requiresDisclosure } from '../src/lib/employer/stage-machine';
import { EMPLOYER_ROLES, canCreateRequisition, canDecideOffer, canMovePipeline, canReadSourcing, canSource, canWriteInterview, canWriteRequisition, employerRoleOf } from '../src/lib/employer/roles';
import { CONSENT_PURPOSES, CONSENT_VERSIONS, ConsentWordingPendingError, SELF_SERVICE_PURPOSES, grantConsent } from '../src/lib/consent';

describe('submission stage machine', () => {
  it('every stage is named once and the table covers all of them', () => {
    assert.deepEqual(Object.keys(STAGE_TRANSITIONS).sort(), [...SUBMISSION_STAGES].sort());
    for (const s of SUBMISSION_STAGES) assert.ok(isSubmissionStage(s));
    assert.ok(!isSubmissionStage('approved'));
  });

  it('the happy path runs forward only; hired, rejected and withdrawn are terminal', () => {
    const path = ['sourced', 'consent_requested', 'consented', 'screening', 'interviewing', 'offered', 'hired'] as const;
    for (let i = 0; i + 1 < path.length; i += 1) {
      assert.ok(canTransition(path[i]!, path[i + 1]!), `${path[i]} -> ${path[i + 1]}`);
      assert.ok(!canTransition(path[i + 1]!, path[i]!), `${path[i + 1]} never goes back to ${path[i]}`);
    }
    for (const terminal of ['hired', 'rejected', 'withdrawn'] as const) assert.deepEqual(STAGE_TRANSITIONS[terminal], []);
    assert.ok(!canTransition('sourced', 'screening'), 'nothing skips the consent stages');
    assert.ok(!canTransition('sourced', 'consented'), 'consent is the candidate\'s act, not a move');
  });

  it('every stage at or past consent requires a granted disclosure, and the undisclosed ones do not', () => {
    for (const s of DISCLOSED_STAGES) assert.ok(requiresDisclosure(s), s);
    for (const s of ['sourced', 'consent_requested', 'rejected', 'withdrawn'] as const) assert.ok(!requiresDisclosure(s), s);
  });
});

describe('employer roles - a named set over the organisation ladder', () => {
  const r = { hiringManagerId: 'hm', recruiterId: 'rec' };
  it('owner and admin are admin; an unknown or null service role is a viewer, the weakest', () => {
    assert.equal(employerRoleOf({ role: 'owner', serviceRole: null }), 'admin');
    assert.equal(employerRoleOf({ role: 'admin', serviceRole: 'viewer' }), 'admin');
    assert.equal(employerRoleOf({ role: 'member', serviceRole: 'recruiter' }), 'recruiter');
    assert.equal(employerRoleOf({ role: 'member', serviceRole: null }), 'viewer');
    assert.equal(employerRoleOf({ role: 'member', serviceRole: 'superuser' }), 'viewer');
    assert.deepEqual([...EMPLOYER_ROLES], ['recruiter', 'hiring_manager', 'interviewer', 'viewer']);
  });
  it('who may do what matches the matrix: recruiters and admins source and ask; a hiring manager reads sourcing and owns their requisition; interviewers write only their interview; viewers read', () => {
    assert.ok(canSource('recruiter') && canSource('admin') && !canSource('hiring_manager') && !canSource('interviewer') && !canSource('viewer'));
    assert.ok(canReadSourcing('hiring_manager') && !canReadSourcing('viewer') && !canReadSourcing('interviewer'));
    assert.ok(canCreateRequisition('hiring_manager') && !canCreateRequisition('interviewer') && !canCreateRequisition('viewer'));
    assert.ok(canWriteRequisition('hiring_manager', r, 'hm') && !canWriteRequisition('hiring_manager', r, 'other'));
    assert.ok(!canMovePipeline('interviewer', r, 'int') && !canMovePipeline('viewer', r, 'v'));
    assert.ok(canWriteInterview('interviewer', r, ['int'], 'int') && !canWriteInterview('interviewer', r, ['someone'], 'int'));
    assert.ok(canDecideOffer('hiring_manager', r, 'hm') && !canDecideOffer('hiring_manager', r, 'other') && !canDecideOffer('recruiter', r, 'rec') && !canDecideOffer('interviewer', r, 'int'), 'offers: admin and the requisition\'s hiring manager');
  });
});

describe('the employer_disclosure consent', () => {
  it('is a purpose with a DRAFT version (L-5 open) and is not a self-service toggle', () => {
    assert.ok((CONSENT_PURPOSES as readonly string[]).includes('employer_disclosure'));
    assert.match(CONSENT_VERSIONS.employer_disclosure, /-draft$/);
    assert.ok(!(SELF_SERVICE_PURPOSES as readonly string[]).includes('employer_disclosure'), 'granted per employer, from a request or an application, never as a global switch');
  });
  it('cannot be recorded in production while its wording is a draft (the register\'s rule, enforced)', async () => {
    const env = process.env.NODE_ENV;
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    try {
      await assert.rejects(() => grantConsent({} as never, { id: 'u', email: 'u@x' }, 'employer_disclosure'), (e: unknown) => e instanceof ConsentWordingPendingError && e.status === 503 && /pending legal review/.test(e.message));
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = env;
    }
  });
});

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* files(full);
    else if (/\.(ts|tsx)$/.test(entry)) yield full;
  }
}

describe('employer code - static boundaries', () => {
  const root = path.resolve(__dirname, '..');
  it('nothing under src/lib/employer reaches the sensitive schema, the AI gateway, a provider, the mailbox or a case record', () => {
    for (const f of files(path.join(root, 'src/lib/employer'))) {
      const text = readFileSync(f, 'utf8');
      const rel = path.relative(root, f);
      assert.ok(!/lib\/sensitive|selfIdentification|self_identification|sensitive\./.test(text), `${rel} touches the sensitive schema`);
      assert.ok(!/@anthropic-ai\/sdk|lib\/ai\/gateway|lib\/ai\/providers|lib\/providers\//.test(text), `${rel} reaches the gateway or a provider`);
      assert.ok(!/lib\/mailbox|emailThread|mailboxConnection/.test(text), `${rel} reads a mailbox`);
      assert.ok(!/\b(caseNote|caseAssessment|CaseNote|CaseAssessment|\.case\.)\b/.test(text), `${rel} names a case record`);
    }
  });
  it('the sourcing cards are built from the compatibility pipeline and the résumé, never from the sensitive schema or a case', () => {
    const text = readFileSync(path.join(root, 'src/lib/employer/candidate-view.ts'), 'utf8');
    assert.match(text, /scoreCompatibility/);
    assert.ok(!/lib\/sensitive|selfIdentification/.test(text));
  });
  it('nothing under matching, eligibility, analytics or the AI gateway names an employer table', () => {
    const offenders: string[] = [];
    for (const dir of ['src/lib/matching', 'src/lib/eligibility', 'src/lib/analytics', 'src/lib/ai']) {
      for (const f of files(path.join(root, dir))) {
        if (/\b(requisition|disclosure|submission|talentPool|employerNote|employerInterview|offer)\.(findMany|findFirst|findUnique|create|update|count|aggregate|groupBy)\b/.test(readFileSync(f, 'utf8'))) offenders.push(path.relative(root, f));
      }
    }
    assert.deepEqual(offenders, []);
  });
});
