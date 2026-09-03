import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeSkill, toResumeContent, type CandidateProfileRecord } from '../src/lib/candidate/profile';
import { preferencesSchema, workAuthorizationSchema } from '../src/lib/candidate/preferences';

/**
 * The projection from the structured Digital Twin to the résumé shape every
 * existing consumer reads, and the validation of the settings half. Pure.
 */
const now = new Date('2026-09-03T00:00:00Z');
const base = { createdAt: now, updatedAt: now };
const profile: CandidateProfileRecord = {
  id: 'cp_u1', userId: 'u1', headline: 'Senior Data Analyst', summary: 'Six years.', currentTitle: null, yearsExperience: null,
  source: 'editor', backfilledAt: null, ...base,
  employment: [
    { id: 'e1', profileId: 'cp_u1', userId: 'u1', company: 'Northbridge', title: 'Senior Analyst', location: 'Toronto', employmentType: null, startDate: '2022-03', endDate: null, isCurrent: true, description: '', bullets: '["Rebuilt reporting"]', sortOrder: 0, ...base },
    { id: 'e2', profileId: 'cp_u1', userId: 'u1', company: 'Halcyon', title: 'Analyst', location: null, employmentType: null, startDate: '2020-01', endDate: '2022-02', isCurrent: false, description: '', bullets: 'not json', sortOrder: 1, ...base },
  ],
  education: [{ id: 'd1', profileId: 'cp_u1', userId: 'u1', institution: 'U of T', credential: 'Honours BSc', fieldOfStudy: 'Statistics', level: null, startYear: null, endYear: 2018, location: 'Toronto', sortOrder: 0, ...base }],
  skills: [
    { id: 's1', profileId: 'cp_u1', userId: 'u1', name: 'SQL', normalizedName: 'sql', skillId: null, proficiency: null, yearsUsed: null, lastUsedYear: null, source: 'self', sortOrder: 0, ...base },
    { id: 's2', profileId: 'cp_u1', userId: 'u1', name: 'Python', normalizedName: 'python', skillId: null, proficiency: null, yearsUsed: null, lastUsedYear: null, source: 'self', sortOrder: 1, ...base },
  ],
  certifications: [{ id: 'c1', profileId: 'cp_u1', userId: 'u1', name: 'Tableau Desktop Specialist', issuer: 'Tableau', issuedAt: null, expiresAt: null, credentialId: null, credentialUrl: null, sortOrder: 0, ...base }],
  projects: [{ id: 'p1', profileId: 'cp_u1', userId: 'u1', name: 'Rental tracker', description: 'Scraped listings', url: null, startDate: null, endDate: null, technologies: '[]', sortOrder: 0, ...base }],
  achievements: [],
  languages: [],
  preferences: null,
  workAuth: null,
};
const contact = { fullName: 'Alex Morgan', email: 'alex@example.test', phone: '+1', city: 'Toronto, ON', linkedinUrl: null, portfolioUrl: null, headline: null };

describe('toResumeContent — the structured profile projected to the legacy shape', () => {
  it('maps every section, marks a current role as Present, and tolerates a malformed bullets column', () => {
    const r = toResumeContent(profile, contact);
    assert.equal(r.fullName, 'Alex Morgan');
    assert.equal(r.headline, 'Senior Data Analyst');
    assert.equal(r.email, 'alex@example.test');
    assert.equal(r.location, 'Toronto, ON');
    assert.equal(r.summary, 'Six years.');
    assert.deepEqual(r.skills, ['SQL', 'Python']);
    assert.deepEqual(r.experience[0], { company: 'Northbridge', title: 'Senior Analyst', location: 'Toronto', startDate: '2022-03', endDate: 'Present', bullets: ['Rebuilt reporting'] });
    assert.deepEqual(r.experience[1].bullets, [], 'a malformed bullets column yields no bullets, not a throw');
    assert.equal(r.experience[1].endDate, '2022-02');
    assert.deepEqual(r.education[0], { institution: 'U of T', credential: 'Honours BSc, Statistics', year: '2018', location: 'Toronto' });
    assert.deepEqual(r.certifications, ['Tableau Desktop Specialist (Tableau)']);
    assert.deepEqual(r.projects, [{ name: 'Rental tracker', description: 'Scraped listings' }]);
  });
  it('contains no field that could carry a sensitive attribute (ADR-0007, by construction)', () => {
    const keys = Object.keys(toResumeContent(profile, contact)).sort();
    assert.deepEqual(keys, ['certifications', 'education', 'email', 'experience', 'fullName', 'headline', 'linkedinUrl', 'location', 'phone', 'portfolioUrl', 'projects', 'skills', 'summary']);
  });
  it('normalizeSkill collapses case and whitespace', () => {
    assert.equal(normalizeSkill('  Machine   Learning '), 'machine learning');
  });
});

describe('preferences validation — consent-shaped settings fail closed', () => {
  it('defaults to hidden, no relocation, assist_only', () => {
    const p = preferencesSchema.parse({});
    assert.equal(p.recruiterVisibility, 'hidden');
    assert.equal(p.relocation, 'no');
    assert.equal(p.autonomy, 'assist_only');
  });
  it('refuses any autonomy above assist_only (ADR-0016), unknown enums, and malformed dates', () => {
    assert.throws(() => preferencesSchema.parse({ autonomy: 'auto_apply' }));
    assert.throws(() => preferencesSchema.parse({ autonomy: 'assisted_apply' }));
    assert.throws(() => preferencesSchema.parse({ workModes: ['hybrid', 'moon'] }));
    assert.throws(() => preferencesSchema.parse({ countries: ['Canada'] }));
    assert.throws(() => preferencesSchema.parse({ availableFrom: 'tomorrow' }));
    assert.throws(() => preferencesSchema.parse({ salaryMinCents: -1 }));
  });
  it('trims and bounds lists', () => {
    const p = preferencesSchema.parse({ targetTitles: [' Data Analyst ', 'BI Developer'] });
    assert.deepEqual(p.targetTitles, ['Data Analyst', 'BI Developer']);
    assert.throws(() => preferencesSchema.parse({ targetTitles: Array.from({ length: 11 }, (_, i) => `t${i}`) }));
  });
  it('work authorisation defaults to unspecified and refuses an unknown status', () => {
    assert.equal(workAuthorizationSchema.parse({}).status, 'unspecified');
    assert.throws(() => workAuthorizationSchema.parse({ status: 'undocumented' }));
  });
});
