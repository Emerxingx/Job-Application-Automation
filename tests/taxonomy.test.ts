/**
 * Stage 04 — the occupational spine (ADR-0009).
 *
 * Pure: the NOC structure-file parser and title normalisation.
 * Database: the licence gate refuses ingestion until a licence is recorded
 * and approved; loading the (hand-written, attributed) fixture builds a
 * correct tree with codes and bilingual labels; the NOC↔SOC crosswalk;
 * bilingual completeness; classification with a recorded method; tenant
 * read access and write refusal on the reference tables.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { nocParentCode, nocTeer, parseNocCsv } from '../src/lib/taxonomy/noc-loader';
import { normalizeTitle } from '../src/lib/taxonomy/classify';
import { inferNocCode } from '../src/lib/taxonomy/fallback';

const EN = readFileSync(path.join(__dirname, 'fixtures', 'noc-2021-sample.csv'), 'utf8');
const FR = readFileSync(path.join(__dirname, 'fixtures', 'noc-2021-sample.fr.csv'), 'utf8');

describe('taxonomy — parser and normalisation (pure)', () => {
  it('parses the NOC structure file shape, quoted fields included', () => {
    const rows = parseNocCsv(EN, 'en');
    assert.equal(rows.length, 17);
    const unit = rows.find((r) => r.code === '21223')!;
    assert.equal(unit.level, 5);
    assert.equal(unit.title, 'Database analysts and data administrators');
    assert.deepEqual(unit.alternateTitles, ['Data analyst', 'Database analyst', 'Data administrator']);
    const broad = rows.find((r) => r.code === '1')!;
    assert.equal(broad.title, 'Business, finance and administration occupations');
  });
  it('derives the hierarchy and TEER from the code', () => {
    assert.equal(nocParentCode('21223'), '2122');
    assert.equal(nocParentCode('2'), null);
    assert.equal(nocTeer('21223'), 1);
    assert.equal(nocTeer('2'), null);
  });
  it('normalises titles: seniority, brackets and trailing qualifiers removed', () => {
    assert.equal(normalizeTitle('Senior Data Analyst (Remote) - Toronto'), 'data analyst');
    assert.equal(normalizeTitle('Software Developer II'), 'software developer');
    assert.equal(normalizeTitle('Analyste de données'), 'analyste de données');
  });
  it('the regex fallback still answers for the common titles and nothing else', () => {
    assert.equal(inferNocCode('Junior Data Analyst'), '21223');
    assert.equal(inferNocCode('Head of Growth'), undefined);
  });
  it('rejects an unrecognised file rather than loading garbage', () => {
    assert.throws(() => parseNocCsv('a,b,c\n1,2,3'), /Unrecognised NOC file/);
  });
});

const CONNECTION_STRING = process.env.TENANCY_TEST_DATABASE_URL;
const REQUIRED = process.env.CI === 'true' || process.env.RLS_TEST_REQUIRED === '1';
if (!CONNECTION_STRING && REQUIRED) throw new Error('TENANCY_TEST_DATABASE_URL is required here (see ci.yml).');
const SKIP = CONNECTION_STRING ? false : 'TENANCY_TEST_DATABASE_URL is not set. REQUIRED in CI.';

type Db = typeof import('../src/lib/db')['db'];
type Datasets = typeof import('../src/lib/taxonomy/datasets');
type Loader = typeof import('../src/lib/taxonomy/noc-loader');
type Classify = typeof import('../src/lib/taxonomy/classify');
type Queries = typeof import('../src/lib/taxonomy/queries');
type Ctx = typeof import('../src/lib/tenancy/context');

const S = randomBytes(4).toString('hex');
const STAFF = { id: `tax_staff_${S}`, email: `tax-${S}@tax.test`, fullName: 'Staff', role: 'admin' as const, storedRole: 'admin' };
const USER = { id: `tax_user_${S}`, email: `tax-user-${S}@tax.test` };
let db: Db;
let datasets: Datasets;
let loader: Loader;
let classify: Classify;
let queries: Queries;
let ctx: Ctx;

describe('taxonomy — licence gate, loading, crosswalk, classification, RLS', { skip: SKIP }, () => {
  before(async () => {
    process.env.DATABASE_URL = CONNECTION_STRING;
    ({ db } = await import('../src/lib/db'));
    datasets = await import('../src/lib/taxonomy/datasets');
    loader = await import('../src/lib/taxonomy/noc-loader');
    classify = await import('../src/lib/taxonomy/classify');
    queries = await import('../src/lib/taxonomy/queries');
    ctx = await import('../src/lib/tenancy/context');
    await db.user.create({ data: { id: USER.id, email: USER.email, passwordHash: 'x', fullName: 'Tenant' } });
    await datasets.ensureDatasetRegistry();
    // A clean spine for this run: the fixture is the only thing ever loaded here.
    await db.occupation.deleteMany();
    await db.taxonomyDataset.updateMany({ data: { licenceStatus: 'unrecorded', ingestionApproved: false, ingestedAt: null, rowCount: 0 } });
  });
  after(async () => {
    await db.user.deleteMany({ where: { id: USER.id } });
    await db.auditLog.deleteMany({ where: { actorId: STAFF.id } });
    await db.$disconnect();
  });

  const rows = () => [...parseNocCsv(EN, 'en'), ...parseNocCsv(FR, 'fr')];

  it('every real dataset starts unrecorded, and the loader refuses all of them', async () => {
    const all = await db.taxonomyDataset.findMany();
    assert.ok(all.length >= 6);
    for (const d of all) assert.equal(d.licenceStatus, 'unrecorded', d.key);
    await assert.rejects(() => loader.loadNocRows(rows(), 'noc-2021'), /licence has not been recorded/);
    await assert.rejects(() => loader.loadNocRows(rows(), 'fixture'), /licence has not been recorded/);
    await assert.rejects(() => loader.loadNocRows(rows(), 'nope'), /not registered/);
    assert.equal(await db.occupation.count(), 0);
  });

  it('a recorded licence without attribution is refused; a recorded licence without approval still refuses ingestion; prohibited never loads', async () => {
    await assert.rejects(
      () => datasets.recordDatasetLicence('fixture', { licenceName: 'Test', attribution: '', status: 'recorded', ingestionApproved: true }, STAFF, 'review'),
      /attribution/,
    );
    await assert.rejects(
      () => datasets.recordDatasetLicence('fixture', { licenceName: 'Test', attribution: 'x', status: 'recorded', ingestionApproved: true }, STAFF, ''),
      /reason/,
    );
    await datasets.recordDatasetLicence('fixture', { licenceName: 'Test fixture', attribution: 'Fixture attribution', status: 'recorded', ingestionApproved: false }, STAFF, 'Test: recorded without approval');
    await assert.rejects(() => loader.loadNocRows(rows(), 'fixture'), /licence has not been recorded and approved/);
    await datasets.recordDatasetLicence('onet', { licenceName: '', attribution: '', status: 'prohibited', ingestionApproved: true }, STAFF, 'Test: counsel says no');
    const onet = await db.taxonomyDataset.findUniqueOrThrow({ where: { key: 'onet' } });
    assert.equal(onet.licenceStatus, 'prohibited');
    assert.equal(onet.ingestionApproved, false, 'approval cannot accompany a prohibition');
    await assert.rejects(() => datasets.requireIngestible(db, 'onet'), /prohibited/);
    const audit = await db.auditLog.findMany({ where: { action: 'taxonomy.licence.recorded', actorId: STAFF.id } });
    assert.equal(audit.length, 2);
    assert.ok(audit.every((a) => a.reason));
  });

  it('loads the attributed fixture under an approved licence: tree, codes, TEER and both locales; idempotent', async () => {
    await datasets.recordDatasetLicence(
      'fixture',
      { licenceName: 'Test fixture', licenceUrl: '', attribution: 'Structure follows Statistics Canada NOC 2021 V1.0 (test fixture)', status: 'recorded', ingestionApproved: true },
      STAFF,
      'Test: fixture approved',
    );
    const first = await loader.loadNocRows(rows(), 'fixture');
    assert.equal(first.occupations, 17);
    assert.equal(first.codes, 17);
    assert.equal(first.labels, 34);
    const second = await loader.loadNocRows(rows(), 'fixture');
    assert.deepEqual(second, { datasetKey: 'fixture', occupations: 0, labels: 0, codes: 0 });

    const unit = await db.occupation.findUniqueOrThrow({ where: { slug: 'noc2021-21223' }, include: { parent: true, codes: true, labels: true } });
    assert.equal(unit.level, 'unit');
    assert.equal(unit.parent?.slug, 'noc2021-2122');
    assert.equal(unit.codes[0].teer, 1);
    assert.deepEqual(unit.labels.map((l) => l.locale).sort(), ['en', 'fr']);
    const broad = await db.occupation.findUniqueOrThrow({ where: { slug: 'noc2021-2' } });
    assert.equal(broad.parentId, null);
    const dataset = await db.taxonomyDataset.findUniqueOrThrow({ where: { key: 'fixture' } });
    assert.equal(dataset.rowCount, 17);
    assert.ok(dataset.ingestedAt);
  });

  it('the integrity report: no orphans, both locales complete, every unit group lacks SOC until the crosswalk loads', async () => {
    const report = await queries.completeness(db);
    assert.equal(report.occupations, 17);
    assert.deepEqual(report.orphans, []);
    assert.deepEqual(report.missingLabels.en, []);
    assert.deepEqual(report.missingLabels.fr, []);
    assert.equal(report.byLevel.unit, 9);
    assert.equal(report.unitGroupsWithoutSoc.length, 9);
  });

  it('NOC ↔ SOC crosswalk: refused until SOC is recorded; then codes attach and translate both ways; malformed codes refused', async () => {
    const entries = [
      { noc: '21223', soc: '15-2051' },
      { noc: '21211', soc: '15-2051' },
      { noc: '21232', soc: '15-1252' },
      { noc: '21231', soc: '15-1252' },
      { noc: '11100', soc: '13-2011' },
      { noc: '99999', soc: '11-1011' },
    ];
    await assert.rejects(() => loader.loadSocCrosswalk(entries, 'soc-2018'), /licence has not been recorded/);
    await datasets.recordDatasetLicence('soc-2018', { licenceName: 'US public domain (test)', attribution: 'SOC 2018, U.S. BLS (test fixture)', status: 'recorded', ingestionApproved: true }, STAFF, 'Test: SOC approved');
    await assert.rejects(() => loader.loadSocCrosswalk([{ noc: '21223', soc: '152051' }], 'soc-2018'), /Malformed SOC/);
    const result = await loader.loadSocCrosswalk(entries, 'soc-2018');
    assert.equal(result.linked, 5);
    assert.deepEqual(result.unmatched, ['99999']);
    assert.deepEqual(await queries.crosswalk(db, { scheme: 'NOC2021', code: '21223' }, 'SOC2018'), ['15-2051']);
    assert.deepEqual(await queries.crosswalk(db, { scheme: 'SOC2018', code: '15-2051' }, 'NOC2021'), ['21211', '21223']);
    assert.deepEqual(await queries.crosswalk(db, { scheme: 'NOC2021', code: '21220' }, 'SOC2018'), []);
    const report = await queries.completeness(db);
    assert.equal(report.unitGroupsWithoutSoc.length, 4);
    assert.equal(report.codesByScheme.SOC2018, 5);
  });

  it('classification records its method: exact title, alternate title, regex fallback, none', async () => {
    const exact = await classify.classifyTitle('Data Scientists');
    assert.equal(exact.method, 'title_exact');
    assert.equal(exact.nocCode, '21211');
    const fr = await classify.classifyTitle('Scientifiques des données');
    assert.equal(fr.method, 'title_exact');
    assert.equal(fr.occupationId, exact.occupationId);
    const alt = await classify.classifyTitle('Senior Full Stack Developer (Toronto)');
    assert.equal(alt.method, 'title_alternate');
    assert.equal(alt.nocCode, '21232');
    const fallback = await classify.classifyTitle('Business Analyst, Payments');
    // "Business analyst" is an alternate title → high confidence, not the regex.
    assert.equal(fallback.method, 'title_alternate');
    const regex = await classify.classifyTitle('Information Security Manager');
    assert.equal(regex.method, 'regex_fallback');
    assert.equal(regex.confidence, 'low');
    assert.equal(regex.nocCode, '21220');
    const none = await classify.classifyTitle('Head of Growth');
    assert.deepEqual(none, { occupationId: null, method: 'none', confidence: 'none', nocCode: null });
  });

  it('search finds by title in either locale, by alternate title, and by code', async () => {
    assert.ok((await queries.searchOccupations(db, 'cyber')).some((o) => o.slug === 'noc2021-21220'));
    assert.ok((await queries.searchOccupations(db, 'cybersécurité')).some((o) => o.slug === 'noc2021-21220'));
    assert.ok((await queries.searchOccupations(db, 'Programmer')).some((o) => o.slug === 'noc2021-21232'));
    assert.ok((await queries.searchOccupations(db, '2122')).some((o) => o.slug === 'noc2021-2122'));
    assert.deepEqual(await queries.searchOccupations(db, '   '), []);
  });

  it('the tenant path reads the spine (no filter) and cannot write it', async () => {
    const seen = await ctx.withTenant({ userId: USER.id }, (tx) => tx.occupation.count());
    assert.equal(seen, 17);
    const search = await ctx.withTenant({ userId: USER.id }, (tx) => queries.searchOccupations(tx, 'data'));
    assert.ok(search.length > 0);
    await assert.rejects(
      () => ctx.withTenant({ userId: USER.id }, (tx) => tx.occupation.create({ data: { slug: `forged-${S}`, level: 'unit' } })),
      /row-level security|42501|permission denied/,
    );
    await assert.rejects(
      () => ctx.withTenant({ userId: USER.id }, (tx) => tx.taxonomyDataset.create({ data: { key: `forged-${S}`, name: 'x', publisher: 'x', scheme: 'X', version: '1' } })),
      /row-level security|42501|permission denied/,
    );
    const changed = await ctx.withTenant({ userId: USER.id }, (tx) => tx.taxonomyDataset.updateMany({ data: { ingestionApproved: true } }));
    assert.equal(changed.count, 0, 'a tenant cannot open the licence gate');
  });
});
