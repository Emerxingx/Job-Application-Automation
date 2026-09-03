/**
 * Stage 07 — the eligibility engine, rule by rule (pure; no database).
 *
 * The coverage matrix: every rule × every candidate state it distinguishes,
 * for both modelled jurisdictions, plus the aggregation laws — a hard fail
 * makes the verdict `ineligible`, `unknown` never excludes, and every rule
 * always states a reason in words with no number in it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RULES_VERSION, evaluateEligibility, exclusionReasons, type CandidateEligibility, type JobEligibilityFacts } from '../src/lib/eligibility/engine';

const TODAY = new Date('2026-09-03T12:00:00Z');

const job = (over: Partial<JobEligibilityFacts> = {}): JobEligibilityFacts => ({
  title: 'Data Analyst',
  country: 'CA',
  location: 'Toronto, ON',
  postalRegion: 'CA-ON/toronto',
  workMode: 'hybrid',
  workAuthorization: null,
  sponsorship: 'unknown',
  certificationRequirements: [],
  languageRequirements: [],
  ...over,
});

const candidate = (over: Partial<CandidateEligibility> = {}): CandidateEligibility => ({
  workAuth: { country: 'CA', status: 'citizen', permitExpiresAt: null, sponsorshipNeeded: false },
  preferences: { countries: ['CA'], locations: ['Toronto'], workModes: ['hybrid', 'remote'], relocation: 'no' },
  certifications: [],
  languages: [{ language: 'en', proficiency: 'native' }],
  ...over,
});

const rule = (c: CandidateEligibility, j: JobEligibilityFacts, id: string) => {
  const r = evaluateEligibility(c, j, TODAY).rules.find((x) => x.rule === id);
  assert.ok(r, `rule ${id} evaluated`);
  return r;
};

describe('eligibility — work authorisation (CA and US)', () => {
  it('no stated requirement passes; a requirement with no recorded authorisation is unknown, never a fail', () => {
    assert.equal(rule(candidate(), job(), 'work_authorization').status, 'pass');
    const r = rule(candidate({ workAuth: null }), job({ workAuthorization: 'authorization_required' }), 'work_authorization');
    assert.equal(r.status, 'unknown');
    assert.match(r.reason, /not recorded/);
    assert.equal(rule(candidate({ workAuth: { country: 'CA', status: 'unspecified', permitExpiresAt: null, sponsorshipNeeded: false } }), job({ workAuthorization: 'authorization_required' }), 'work_authorization').status, 'unknown');
  });
  it('citizens and permanent residents pass both kinds of requirement in their country', () => {
    for (const status of ['citizen', 'permanent_resident']) {
      for (const req of ['authorization_required', 'citizenship_or_pr_required']) {
        for (const country of ['CA', 'US']) {
          assert.equal(rule(candidate({ workAuth: { country, status, permitExpiresAt: null, sponsorshipNeeded: false } }), job({ country, workAuthorization: req }), 'work_authorization').status, 'pass', `${status} ${req} ${country}`);
        }
      }
    }
  });
  it('a work permit passes an authorisation requirement while valid, fails when expired, and fails a citizenship requirement', () => {
    const permit = (permitExpiresAt: string | null) => candidate({ workAuth: { country: 'CA', status: 'work_permit', permitExpiresAt, sponsorshipNeeded: false } });
    assert.equal(rule(permit(null), job({ workAuthorization: 'authorization_required' }), 'work_authorization').status, 'pass');
    assert.equal(rule(permit('2027-01-31'), job({ workAuthorization: 'authorization_required' }), 'work_authorization').status, 'pass');
    const expired = rule(permit('2026-08-31'), job({ workAuthorization: 'authorization_required' }), 'work_authorization');
    assert.equal(expired.status, 'fail');
    assert.match(expired.reason, /expired on 2026-08-31/);
    assert.equal(rule(permit('2027-01-31'), job({ workAuthorization: 'citizenship_or_pr_required' }), 'work_authorization').status, 'fail');
  });
  it('a study permit is unknown (limited work) unless citizenship is required; needing sponsorship fails; the wrong country fails with the fix named', () => {
    const study = candidate({ workAuth: { country: 'CA', status: 'study_permit', permitExpiresAt: null, sponsorshipNeeded: false } });
    assert.equal(rule(study, job({ workAuthorization: 'authorization_required' }), 'work_authorization').status, 'unknown');
    assert.equal(rule(study, job({ workAuthorization: 'citizenship_or_pr_required' }), 'work_authorization').status, 'fail');
    assert.equal(rule(candidate({ workAuth: { country: 'CA', status: 'requires_sponsorship', permitExpiresAt: null, sponsorshipNeeded: true } }), job({ workAuthorization: 'authorization_required' }), 'work_authorization').status, 'fail');
    const wrong = rule(candidate(), job({ country: 'US', workAuthorization: 'authorization_required' }), 'work_authorization');
    assert.equal(wrong.status, 'fail');
    assert.match(wrong.reason, /United States.*recorded authorisation is for Canada/);
  });
  it('an unmodelled jurisdiction is unknown', () => {
    assert.equal(rule(candidate(), job({ country: 'GB', workAuthorization: 'authorization_required' }), 'work_authorization').status, 'unknown');
  });
});

describe('eligibility — sponsorship, clearance, location', () => {
  it('sponsorship: needed + not offered fails; needed + offered passes; needed + silent is unknown; not needed passes', () => {
    const needs = candidate({ workAuth: { country: 'CA', status: 'work_permit', permitExpiresAt: null, sponsorshipNeeded: true } });
    assert.equal(rule(needs, job({ sponsorship: 'not_offered' }), 'sponsorship').status, 'fail');
    assert.equal(rule(needs, job({ sponsorship: 'offered' }), 'sponsorship').status, 'pass');
    assert.equal(rule(needs, job({ sponsorship: 'unknown' }), 'sponsorship').status, 'unknown');
    assert.equal(rule(candidate(), job({ sponsorship: 'not_offered' }), 'sponsorship').status, 'pass');
  });
  it('clearance: required is unknown (not modelled on the profile), never a fail', () => {
    const r = rule(candidate(), job({ workAuthorization: 'security_clearance_required' }), 'security_clearance');
    assert.equal(r.status, 'unknown');
    assert.equal(rule(candidate(), job(), 'security_clearance').status, 'pass');
  });
  it('location: remote passes; a listed place passes; another country fails unless open to relocating; an unparseable place is unknown; no preference passes', () => {
    assert.equal(rule(candidate(), job({ workMode: 'remote', country: 'US', location: 'Remote' }), 'location').status, 'pass');
    assert.equal(rule(candidate(), job(), 'location').status, 'pass');
    assert.equal(rule(candidate({ preferences: { countries: ['CA'], locations: ['Ontario'], workModes: [], relocation: 'no' } }), job(), 'location').status, 'pass', 'a province name matches the region');
    const abroad = rule(candidate(), job({ country: 'US', location: 'Austin, TX', postalRegion: 'US-TX/austin' }), 'location');
    assert.equal(abroad.status, 'fail');
    assert.match(abroad.reason, /not open to relocating/);
    assert.equal(rule(candidate({ preferences: { countries: ['CA'], locations: ['Toronto'], workModes: [], relocation: 'open' } }), job({ country: 'US', location: 'Austin, TX', postalRegion: 'US-TX/austin' }), 'location').status, 'pass');
    const elsewhere = rule(candidate(), job({ location: 'Calgary, AB', postalRegion: 'CA-AB/calgary' }), 'location');
    assert.equal(elsewhere.status, 'fail');
    assert.equal(rule(candidate(), job({ location: 'Somewhere', postalRegion: null }), 'location').status, 'unknown');
    assert.equal(rule(candidate({ preferences: null }), job({ country: 'US', location: 'Austin, TX', postalRegion: 'US-TX/austin' }), 'location').status, 'pass');
  });
});

describe('eligibility — licensure and language are advisory unless the title demands a licence', () => {
  it('a licensed designation the title demands fails when missing and passes when held; a certification merely mentioned is unknown', () => {
    const nurse = job({ title: 'Registered Nurse — Medical Surgical', certificationRequirements: ['rn', 'bls'] });
    const missing = rule(candidate(), nurse, 'licensure');
    assert.equal(missing.status, 'fail');
    assert.equal(missing.hard, true);
    assert.match(missing.reason, /Registered Nurse \(RN\) licence/);
    const held = rule(candidate({ certifications: ['RN — College of Nurses of Ontario', 'BLS'] }), nurse, 'licensure');
    assert.equal(held.status, 'pass');
    const advisory = rule(candidate(), job({ title: 'Cloud Engineer', certificationRequirements: ['aws certified solutions architect'] }), 'licensure');
    assert.equal(advisory.status, 'unknown');
    assert.equal(advisory.hard, false);
    assert.match(advisory.reason, /may prefer rather than require/);
    assert.equal(rule(candidate(), job({ title: 'Analyst', certificationRequirements: ['rn'] }), 'licensure').status, 'unknown', 'a licence the title does not demand is advisory');
  });
  it('language: bilingual in Canada means English and French; a listed language at a working level passes; otherwise unknown, never a fail', () => {
    const bilingual = job({ languageRequirements: ['bilingual'] });
    const r = rule(candidate(), bilingual, 'language');
    assert.equal(r.status, 'unknown');
    assert.equal(r.hard, false);
    assert.match(r.reason, /french/);
    assert.equal(rule(candidate({ languages: [{ language: 'en', proficiency: 'native' }, { language: 'fr', proficiency: 'professional' }] }), bilingual, 'language').status, 'pass');
    assert.equal(rule(candidate({ languages: [{ language: 'en', proficiency: 'native' }, { language: 'french', proficiency: 'basic' }] }), bilingual, 'language').status, 'unknown', 'basic is not a working level');
    assert.equal(rule(candidate(), job(), 'language').status, 'pass');
  });
});

describe('eligibility — the verdict', () => {
  it('a hard fail is ineligible with its reasons; unknown never excludes; all pass is eligible; there is never a number', () => {
    const needs = candidate({ workAuth: { country: 'CA', status: 'requires_sponsorship', permitExpiresAt: null, sponsorshipNeeded: true } });
    const out = evaluateEligibility(needs, job({ workAuthorization: 'authorization_required', sponsorship: 'not_offered' }), TODAY);
    assert.equal(out.outcome, 'ineligible');
    assert.equal(exclusionReasons(out).length, 2);
    assert.equal(out.rulesVersion, RULES_VERSION);
    const open = evaluateEligibility(candidate(), job({ workAuthorization: 'security_clearance_required' }), TODAY);
    assert.equal(open.outcome, 'unknown');
    assert.deepEqual(exclusionReasons(open), []);
    const fine = evaluateEligibility(candidate(), job(), TODAY);
    assert.equal(fine.outcome, 'eligible');
    for (const v of [out, open, fine]) {
      assert.equal(v.rules.length, 6, 'every rule is evaluated every time');
      for (const r of v.rules) {
        assert.ok(r.reason.length > 10, `${r.rule} states a reason`);
        assert.ok(!/\b\d{1,3}\s?%/.test(r.reason), `${r.rule}: no percentage`);
      }
    }
    const advisoryOnly = evaluateEligibility(candidate(), job({ certificationRequirements: ['pmp'] }), TODAY);
    assert.equal(advisoryOnly.outcome, 'unknown', 'an advisory unknown leaves the question open');
    assert.deepEqual(exclusionReasons(advisoryOnly), [], 'but never excludes');
  });
  it('is deterministic', () => {
    const a = evaluateEligibility(candidate(), job({ workAuthorization: 'authorization_required' }), TODAY);
    const b = evaluateEligibility(candidate(), job({ workAuthorization: 'authorization_required' }), TODAY);
    assert.deepEqual(a, b);
  });
});
