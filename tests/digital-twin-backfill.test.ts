/**
 * The expand-and-backfill of ADR-0002 for the Digital Twin, rehearsed: the
 * migration's backfill block is executed against a résumé inserted AFTER the
 * history was applied, so the rows it produces, the row counts it reports and
 * its idempotency are all measured rather than assumed.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const CONNECTION_STRING = process.env.TENANCY_TEST_DATABASE_URL;
const REQUIRED = process.env.CI === 'true' || process.env.RLS_TEST_REQUIRED === '1';
if (!CONNECTION_STRING && REQUIRED) throw new Error('TENANCY_TEST_DATABASE_URL is required here (see ci.yml).');
const SKIP = CONNECTION_STRING ? false : 'TENANCY_TEST_DATABASE_URL is not set. REQUIRED in CI.';

type Db = typeof import('../src/lib/db')['db'];
type Profile = typeof import('../src/lib/candidate/profile');
const S = randomBytes(4).toString('hex');
const U = { id: `bf_${S}`, email: `bf-${S}@twin.test` };
const BAD = { id: `bfbad_${S}`, email: `bfbad-${S}@twin.test` };
let db: Db;
let profile: Profile;
let backfill: string;

const RESUME = {
  fullName: 'Alex Morgan', headline: 'Senior Data Analyst', email: U.email, summary: 'Six years of turning data into decisions.',
  skills: ['SQL', 'Python', 'sql', ' Tableau '],
  experience: [
    { company: 'Northbridge', title: 'Senior Data Analyst', location: 'Toronto, ON', startDate: '2022-03', endDate: 'Present ', bullets: ['Rebuilt reporting', 'Ran 40 tests'] },
    { company: 'Halcyon', title: 'Data Analyst', startDate: '2020-01', endDate: '2022-02', bullets: [] },
    'not an object',
  ],
  education: [{ institution: 'University of Toronto', credential: 'Honours BSc, Statistics', year: '2018', location: 'Toronto, ON' }, { institution: 'Nowhere', credential: 'x', year: 'n/a' }],
  certifications: ['Google Data Analytics', '', 7],
  projects: [{ name: 'Rental tracker', description: 'Scraped listings' }, { description: 'nameless' }],
};

describe('Digital Twin backfill — measured', { skip: SKIP }, () => {
  before(async () => {
    process.env.DATABASE_URL = CONNECTION_STRING;
    ({ db } = await import('../src/lib/db'));
    profile = await import('../src/lib/candidate/profile');
    const dir = readdirSync(path.resolve(__dirname, '../prisma/migrations')).find((d) => d.endsWith('_candidate_digital_twin'));
    assert.ok(dir);
    const sql = readFileSync(path.resolve(__dirname, '../prisma/migrations', dir, 'migration.sql'), 'utf8');
    const start = sql.indexOf('DO $$');
    assert.ok(start > 0, 'the migration must carry the backfill block');
    backfill = sql.slice(start);
    for (const u of [U, BAD]) {
      await db.user.create({ data: { id: u.id, email: u.email, passwordHash: 'x', fullName: 'Backfill' } });
    }
    await db.resume.create({ data: { userId: U.id, label: 'Master Resume', isMaster: true, content: JSON.stringify(RESUME), rawText: '' } });
    await db.resume.create({ data: { userId: BAD.id, label: 'Master Resume', isMaster: true, content: '{not json', rawText: '' } });
  });
  after(async () => {
    await db.user.deleteMany({ where: { id: { in: [U.id, BAD.id] } } }); // cascades resume + profile rows
    await db.auditLog.deleteMany({ where: { action: 'migration.backfill', entityId: 'candidate_digital_twin' } });
    await db.$disconnect();
  });

  it('creates the structured rows from the résumé JSON, with the counts the migration reports', async () => {
    await db.$executeRawUnsafe(backfill);
    const p = await profile.loadProfile(db, U.id);
    assert.ok(p, 'a profile was created');
    assert.equal(p.id, `cp_${U.id}`);
    assert.equal(p.source, 'resume_backfill');
    assert.ok(p.backfilledAt);
    assert.equal(p.headline, 'Senior Data Analyst');
    assert.equal(p.employment.length, 2, 'the non-object entry is skipped');
    assert.equal(p.employment[0].isCurrent, true, '"Present " with trailing space is still current');
    assert.equal(p.employment[0].endDate, null);
    assert.deepEqual(JSON.parse(p.employment[0].bullets), ['Rebuilt reporting', 'Ran 40 tests']);
    assert.equal(p.employment[1].endDate, '2022-02');
    assert.equal(p.education.length, 2);
    assert.equal(p.education[0].endYear, 2018);
    assert.equal(p.education[1].endYear, null, 'a non-numeric year becomes null, not a failure');
    assert.deepEqual(p.skills.map((s) => s.name), ['SQL', 'Python', 'Tableau'], 'de-duplicated on the normalised form, trimmed');
    assert.deepEqual(p.certifications.map((c) => c.name), ['Google Data Analytics'], 'empty and non-string entries skipped');
    assert.deepEqual(p.projects.map((x) => x.name), ['Rental tracker'], 'a nameless project is skipped');
    assert.equal(await db.candidateProfile.count({ where: { userId: BAD.id } }), 0, 'unparseable JSON skips the user, with a NOTICE, without failing');

    // The persisted report: counts of rows INSERTED (a duplicate skill is not
    // a row), readable after `migrate deploy`, which does not relay NOTICEs.
    const report = await db.auditLog.findFirst({ where: { action: 'migration.backfill', entityId: 'candidate_digital_twin' }, orderBy: { createdAt: 'desc' } });
    assert.ok(report, 'the backfill writes a system audit row with its counts');
    const counts = JSON.parse(report.after) as Record<string, number>;
    assert.equal(counts.profiles, 1);
    assert.equal(counts.skipped, 1);
    assert.equal(counts.employment, 2);
    assert.equal(counts.education, 2);
    assert.equal(counts.skills, 3, 'four entries, one duplicate on the normalised form → three rows');
    assert.equal(counts.certifications, 1);
    assert.equal(counts.projects, 1);
  });

  it('is idempotent: running it again inserts nothing', async () => {
    // Counted for THIS user only: test files run in parallel (node --test), so
    // a global count can move between the two reads when another suite
    // inserts a profile row of its own, which is not what is being asserted.
    const where = { userId: U.id };
    const count = () => Promise.all([
      db.candidateProfile.count({ where }), db.employmentHistory.count({ where }), db.education.count({ where }),
      db.candidateSkill.count({ where }), db.certification.count({ where }), db.project.count({ where }),
    ]);
    const before = await count();
    assert.deepEqual(before, [1, 2, 2, 3, 1, 1], 'the first run left exactly the reported rows');
    await db.$executeRawUnsafe(backfill);
    assert.deepEqual(await count(), before);
  });

  it('an EMPTY profile (created by saving preferences) is not a résumé: the guard still refuses', async () => {
    const { savePreferences, preferencesSchema } = await import('../src/lib/candidate/preferences');
    const empty = { id: `bfempty_${S}`, email: `bfempty-${S}@twin.test` };
    await db.user.create({ data: { id: empty.id, email: empty.email, passwordHash: 'x', fullName: 'Empty' } });
    try {
      await db.$transaction((tx) => savePreferences(tx, empty.id, preferencesSchema.parse({})));
      assert.ok(await db.candidateProfile.findFirst({ where: { userId: empty.id } }), 'a profile row exists');
      assert.equal(await profile.loadResumeContent(db, empty.id), null, 'but it is not a résumé');
    } finally {
      await db.user.delete({ where: { id: empty.id } });
    }
  });

  it('round-trips: the projection of the backfilled rows equals the résumé the editor would show', async () => {
    const content = await profile.loadResumeContent(db, U.id);
    assert.ok(content);
    assert.equal(content.headline, 'Senior Data Analyst');
    assert.deepEqual(content.skills, ['SQL', 'Python', 'Tableau']);
    assert.equal(content.experience[0].endDate, 'Present');
    assert.equal(content.education[0].year, '2018');
  });

  it('the editor save path replaces sections and rewrites the projection in one transaction', async () => {
    const content = (await profile.loadResumeContent(db, U.id))!;
    content.skills = ['dbt'];
    content.experience = content.experience.slice(0, 1);
    await db.$transaction(async (tx) => {
      await profile.saveResumeSections(tx, U.id, content);
      await profile.writeResumeProjection(tx, U.id, content);
    });
    const p = (await profile.loadProfile(db, U.id))!;
    assert.deepEqual(p.skills.map((s) => s.name), ['dbt']);
    assert.equal(p.employment.length, 1);
    assert.equal(p.source, 'editor');
    const legacy = await db.resume.findFirst({ where: { userId: U.id, isMaster: true } });
    assert.deepEqual(JSON.parse(legacy!.content).skills, ['dbt'], 'the legacy column is a projection of the rows');
  });
});
