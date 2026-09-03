/**
 * Stage 12 — the question bank in the prepared application (pure).
 * NEVER_AUTOMATE carries no value whatever is stored; ASK_IF_CHANGED asks
 * until confirmed; REQUIRE_REVIEW is shown to review; contact answers fill;
 * a profile value stands in only where a mapping names it and the policy
 * allows a value at all; the field-mapping matcher and validator hold.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ApplicationQuestion } from '@prisma/client';
import { BUILTIN_FIELD_MAPPINGS, matchMapping, validateMappings } from '../src/lib/apply/field-mappings';
import { carriesNeverAutomatedValue, prepareQuestions, profileValueFor } from '../src/lib/apply/prepare';
import type { ApplicantProfile } from '../src/lib/providers/apply';

const applicant: ApplicantProfile = { fullName: 'Alex Morgan', firstName: 'Alex', lastName: 'Morgan', email: 'alex@example.com', phone: '+1 416 555 0142', linkedinUrl: 'https://linkedin.com/in/alexmorgan', workAuthorization: 'Permanent Resident', requiresSponsorship: false };

function q(over: Partial<ApplicationQuestion> & { question: string }): ApplicationQuestion {
  const now = new Date('2026-09-01T00:00:00Z');
  return { id: over.question.replace(/\W+/g, '_').toLowerCase(), userId: 'u', key: over.question.toLowerCase(), category: 'other', riskLevel: 'medium', policy: 'REQUIRE_REVIEW', answer: '', evidenceIds: '[]', answerUpdatedAt: now, lastConfirmedAt: null, createdAt: now, updatedAt: now, ...over };
}

describe('prepared questions', () => {
  it('a NEVER_AUTOMATE question carries no value, even when an answer is stored', () => {
    const rows = [
      q({ question: 'Do you have a disability?', category: 'sensitive', policy: 'NEVER_AUTOMATE', answer: '' }),
      q({ question: 'Are you willing to relocate?', category: 'logistics', policy: 'NEVER_AUTOMATE', answer: 'Yes, anywhere in Canada' }),
    ];
    const prepared = prepareQuestions(rows, BUILTIN_FIELD_MAPPINGS, applicant);
    for (const p of prepared) {
      assert.equal(p.decision, 'never', p.question);
      assert.equal(p.value, '', p.question);
      assert.deepEqual(p.evidenceIds, []);
    }
    assert.equal(carriesNeverAutomatedValue(prepared), false);
    assert.equal(carriesNeverAutomatedValue([{ ...prepared[1], value: 'leaked' }]), true, 'the guard sees a leaked value');
  });

  it('follows the policy: contact fills, ASK_IF_CHANGED asks until confirmed, REQUIRE_REVIEW reviews', () => {
    const now = new Date('2026-09-02T00:00:00Z');
    const rows = [
      q({ question: 'What is your LinkedIn profile?', category: 'contact', policy: 'AUTO_FILL', answer: 'https://linkedin.com/in/alexmorgan' }),
      q({ question: 'What is your notice period?', category: 'logistics', policy: 'ASK_IF_CHANGED', answer: '2 weeks' }),
      q({ question: 'What is your earliest start date?', category: 'logistics', policy: 'ASK_IF_CHANGED', answer: 'October 1', lastConfirmedAt: now, answerUpdatedAt: new Date('2026-09-01T00:00:00Z') }),
      q({ question: 'What are your salary expectations?', category: 'compensation', policy: 'REQUIRE_REVIEW', answer: '95,000 CAD', evidenceIds: '["ev_1"]' }),
      q({ question: 'Why do you want to work here?', category: 'motivation', policy: 'REQUIRE_REVIEW', answer: '' }),
    ];
    const by = Object.fromEntries(prepareQuestions(rows, BUILTIN_FIELD_MAPPINGS, applicant).map((p) => [p.question, p]));
    assert.equal(by['What is your LinkedIn profile?'].decision, 'fill');
    assert.equal(by['What is your LinkedIn profile?'].canonicalKey, 'linkedin_url');
    assert.equal(by['What is your notice period?'].decision, 'ask');
    assert.equal(by['What is your notice period?'].canonicalKey, 'notice_period');
    assert.equal(by['What is your earliest start date?'].decision, 'fill', 'confirmed after the last change');
    assert.equal(by['What are your salary expectations?'].decision, 'review');
    assert.equal(by['What are your salary expectations?'].value, '95,000 CAD');
    assert.deepEqual(by['What are your salary expectations?'].evidenceIds, ['ev_1']);
    assert.equal(by['Why do you want to work here?'].decision, 'review');
    assert.equal(by['Why do you want to work here?'].value, '', 'nothing stored, nothing invented');
    assert.equal(by['Why do you want to work here?'].canonicalKey, null);
  });

  it('the profile stands in only where a mapping names a profile fact and nothing is stored', () => {
    const rows = [
      q({ question: 'Are you legally authorized to work in Canada?', category: 'eligibility', policy: 'REQUIRE_REVIEW', answer: '' }),
      q({ question: 'Will you now or in the future require sponsorship?', category: 'eligibility', policy: 'REQUIRE_REVIEW', answer: '' }),
      q({ question: 'What are your salary expectations?', category: 'compensation', policy: 'REQUIRE_REVIEW', answer: '' }),
    ];
    const by = Object.fromEntries(prepareQuestions(rows, BUILTIN_FIELD_MAPPINGS, applicant).map((p) => [p.canonicalKey ?? p.question, p]));
    assert.equal(by.work_authorization.value, 'Permanent Resident');
    assert.equal(by.work_authorization.decision, 'review', 'eligibility never drops below review');
    assert.equal(by.requires_sponsorship.value, 'No');
    assert.equal(by.salary_expectation.value, '', 'no profile fact for a salary — never a number');
    assert.equal(profileValueFor('salary_expectation', applicant), null);
    assert.equal(profileValueFor('phone', applicant), '+1 416 555 0142');
  });

  it('orders fill → ask → review → never so the applicant sees what is ready first', () => {
    const rows = [
      q({ question: 'Veteran status?', category: 'sensitive', policy: 'NEVER_AUTOMATE' }),
      q({ question: 'Phone number?', category: 'contact', policy: 'AUTO_FILL', answer: '+1' }),
      q({ question: 'Tell us about yourself', category: 'screening', policy: 'REQUIRE_REVIEW', answer: 'x' }),
      q({ question: 'Notice period?', category: 'logistics', policy: 'ASK_IF_CHANGED', answer: '2w' }),
    ];
    assert.deepEqual(prepareQuestions(rows, BUILTIN_FIELD_MAPPINGS, applicant).map((p) => p.decision), ['fill', 'ask', 'review', 'never']);
  });
});

describe('field mappings — matcher and validator (pure)', () => {
  it('matches a form label to the first mapping whose pattern it satisfies, case- and punctuation-insensitively', () => {
    assert.equal(matchMapping('Are you legally allowed to work in the US?', BUILTIN_FIELD_MAPPINGS)?.canonicalFieldKey, 'work_authorization');
    assert.equal(matchMapping('Will you require visa SPONSORSHIP now or in the future?', BUILTIN_FIELD_MAPPINGS)?.canonicalFieldKey, 'requires_sponsorship');
    assert.equal(matchMapping('Desired salary (CAD)', BUILTIN_FIELD_MAPPINGS)?.canonicalFieldKey, 'salary_expectation');
    assert.equal(matchMapping('How many years of Python experience do you have?', BUILTIN_FIELD_MAPPINGS)?.canonicalFieldKey, 'years_of_experience');
    assert.equal(matchMapping('Favourite colour?', BUILTIN_FIELD_MAPPINGS), null);
    assert.equal(matchMapping('Do you prefer remote or hybrid?', BUILTIN_FIELD_MAPPINGS)?.canonicalFieldKey, 'work_location_preference');
  });

  it('the built-in set validates; a duplicate key, a bad regex, a select without options or a fabricating fallback rule is refused', () => {
    assert.equal(validateMappings(BUILTIN_FIELD_MAPPINGS), null);
    const one = BUILTIN_FIELD_MAPPINGS[0];
    assert.match(validateMappings([one, one])!, /duplicate/);
    assert.match(validateMappings([{ ...one, patterns: [{ kind: 'regex', pattern: '(' }] }])!, /invalid regex/);
    assert.match(validateMappings([{ ...one, dataType: 'select', selectOptions: [] }])!, /select needs its options/);
    assert.match(validateMappings([{ ...one, fallbackRule: 'If unknown, assume yes.' }])!, /invent, assume or guess/);
    assert.match(validateMappings([{ ...one, canonicalFieldKey: 'Work-Auth' }])!, /snake_case/);
    assert.match(validateMappings([])!, /non-empty/);
  });
});
