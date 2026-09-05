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
import './helpers/database-env'; // FIRST: the static imports below reach src/lib/db
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { nocParentCode, nocTeer, parseNocCsv, parseNocElementsCsv, withExamples } from '../src/lib/taxonomy/noc-loader';
import { normalizeTitle, titleCandidates } from '../src/lib/taxonomy/classify';
import { inferNocCode } from '../src/lib/taxonomy/fallback';

const EN = readFileSync(path.join(__dirname, 'fixtures', 'noc-2021-sample.csv'), 'utf8');
const FR = readFileSync(path.join(__dirname, 'fixtures', 'noc-2021-sample.fr.csv'), 'utf8');
const EN_ELEMENTS = readFileSync(path.join(__dirname, 'fixtures', 'noc-2021-elements-sample.csv'), 'utf8');
const FR_ELEMENTS = readFileSync(path.join(__dirname, 'fixtures', 'noc-2021-elements-sample.fr.csv'), 'utf8');

describe('taxonomy — parser and normalisation (pure)', () => {
  it('parses the published structure-file shape: BOM, EN and FR headers, quoted fields', () => {
    assert.equal(EN.charCodeAt(0), 0xfeff, 'the fixture carries the BOM the download carries');
    const rows = parseNocCsv(EN, 'en');
    assert.equal(rows.length, 19);
    const unit = rows.find((r) => r.code === '21223')!;
    assert.equal(unit.level, 5);
    assert.equal(unit.title, 'Database analysts and data administrators');
    assert.deepEqual(unit.alternateTitles, [], 'the structure file carries no examples');
    const broad = rows.find((r) => r.code === '1')!;
    assert.equal(broad.title, 'Business, finance and administration occupations');
    const fr = parseNocCsv(FR, 'fr');
    assert.equal(fr.length, 19);
    assert.equal(fr.find((r) => r.code === '2122')!.title, "Personnel professionnel en informatique et en systèmes d'information");
  });
  it('parses the elements file and merges illustrative examples as alternate titles', () => {
    const en = parseNocElementsCsv(EN_ELEMENTS);
    assert.deepEqual(en.get('21232'), ['Software developer', 'Full-stack developer', 'Programmer']);
    assert.equal(en.has('21233'), false);
    assert.deepEqual(en.get('21223'), ['Data analyst', 'Database analyst'], 'main duties are not examples');
    const fr = parseNocElementsCsv(FR_ELEMENTS);
    assert.deepEqual(fr.get('21221'), ["Analyste d'affaires"]);
    const merged = withExamples(parseNocCsv(EN, 'en'), en);
    assert.deepEqual(merged.find((r) => r.code === '21232')!.alternateTitles, ['Software developer', 'Full-stack developer', 'Programmer']);
    assert.throws(() => parseNocElementsCsv('a,b\n1,2'), /Unrecognised NOC elements file/);
  });
  it('derives the hierarchy and TEER from the code', () => {
    assert.equal(nocParentCode('21223'), '2122');
    assert.equal(nocParentCode('2'), null);
    assert.equal(nocTeer('21223'), 1);
    assert.equal(nocTeer('2'), null);
  });
  it('normalises both sides the same way: punctuation to spaces, qualifiers only at the ends, candidates by head', () => {
    assert.equal(normalizeTitle('Senior Full-Stack Developer (Toronto)'), 'full stack developer');
    assert.equal(normalizeTitle('Front-End Developer'), 'front end developer');
    assert.equal(normalizeTitle('Chief of Staff'), 'of staff', 'a leading qualifier goes; the middle stays');
    assert.equal(normalizeTitle('Lead Hand'), 'hand');
    assert.equal(normalizeTitle('Software Developer II'), 'software developer');
    assert.equal(normalizeTitle("Personnel professionnel en informatique et en systèmes d'information"), 'personnel professionnel en informatique et en systèmes d information');
    assert.equal(normalizeTitle('Développeurs/développeuses et programmeurs/programmeuses Web'), 'développeurs développeuses et programmeurs programmeuses web');
    assert.equal(normalizeTitle('Business, finance and administration occupations'), 'business finance and administration occupations');
    assert.deepEqual(titleCandidates('Senior Data Analyst (Remote) - Toronto'), ['data analyst toronto', 'data analyst']);
    assert.deepEqual(titleCandidates('Business Analyst, Payments'), ['business analyst payments', 'business analyst']);
    assert.deepEqual(titleCandidates('Data Scientists'), ['data scientists']);
  });
  it('the regex fallback still answers for the common titles and nothing else', () => {
    assert.equal(inferNocCode('Junior Data Analyst'), '21223');
    assert.equal(inferNocCode('Head of Growth'), undefined);
  });
  it('rejects an unrecognised file rather than loading garbage', () => {
    assert.throws(() => parseNocCsv('a,b,c\n1,2,3'), /Unrecognised NOC structure file/);
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
    // Scoped reset: only what an earlier run of THIS suite could have left —
    // the fixture's and the SOC sample's rows and gate state, and the
    // prohibition this suite records on onet. Nothing else is touched.
    for (const key of ['fixture', 'soc-2018', 'onet']) {
      const d = await db.taxonomyDataset.findUniqueOrThrow({ where: { key } });
      await db.occupation.deleteMany({ where: { datasetId: d.id } });
      await db.occupationCode.deleteMany({ where: { scheme: d.scheme, version: d.version } });
      await db.taxonomyDataset.update({ where: { key }, data: { licenceStatus: 'unrecorded', ingestionApproved: false, ingestedAt: null, rowCount: 0, licenceName: '', attribution: '' } });
    }
  });
  after(async () => {
    for (const key of ['fixture', 'soc-2018', 'onet']) {
      const d = await db.taxonomyDataset.findUniqueOrThrow({ where: { key } });
      await db.occupation.deleteMany({ where: { datasetId: d.id } });
      await db.occupationCode.deleteMany({ where: { scheme: d.scheme, version: d.version } });
      await db.taxonomyDataset.update({ where: { key }, data: { licenceStatus: 'unrecorded', ingestionApproved: false, ingestedAt: null, rowCount: 0, licenceName: '', attribution: '' } });
    }
    await db.user.deleteMany({ where: { id: USER.id } });
    await db.auditLog.deleteMany({ where: { actorId: STAFF.id } });
    await db.$disconnect();
  });

  const rows = () => [...withExamples(parseNocCsv(EN, 'en'), parseNocElementsCsv(EN_ELEMENTS)), ...withExamples(parseNocCsv(FR, 'fr'), parseNocElementsCsv(FR_ELEMENTS))];

  it('every real dataset starts unrecorded, and the loader refuses all of them', async () => {
    const all = await db.taxonomyDataset.findMany();
    assert.ok(all.length >= 6);
    // The learning-graph suite (Stage 16) records its own fixture-like keys concurrently; the real datasets it never touches.
    for (const d of all.filter((x) => !['fixture', 'soc-2018', 'onet'].includes(x.key) && !x.key.startsWith('learning-'))) assert.equal(d.licenceStatus, 'unrecorded', d.key);
    assert.ok(all.every((d) => d.publisherTerms.length > 0), 'the publisher terms are synced from the registry');
    await assert.rejects(() => loader.loadNocRows(rows(), 'noc-2021'), /licence has not been recorded/);
    await assert.rejects(() => loader.loadNocRows(rows(), 'fixture'), /licence has not been recorded/);
    await assert.rejects(() => loader.loadNocRows(rows(), 'nope'), /not registered/);
    assert.equal(await db.occupation.count({ where: { slug: { startsWith: 'noc2021-' } } }), 0);
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
    await assert.rejects(() => datasets.recordDatasetLicence('nope', { licenceName: 'x', attribution: 'x', status: 'recorded', ingestionApproved: true }, STAFF, 'r'), (e: Error & { status: number }) => e.status === 404);
    const audit = await db.auditLog.findMany({ where: { action: 'taxonomy.licence.recorded', actorId: STAFF.id }, orderBy: { createdAt: 'asc' } });
    assert.equal(audit.length, 2);
    assert.ok(audit.every((a) => a.reason));
    assert.ok(JSON.parse(audit[0].changedFields).includes('licenceStatus'));
  });

  it('a unit-groups-only extract is refused: every node needs its parent', async () => {
    await datasets.recordDatasetLicence('fixture', { licenceName: 'Test fixture', attribution: 'Fixture attribution', status: 'recorded', ingestionApproved: true }, STAFF, 'Test: fixture approved');
    const unitsOnly = rows().filter((r) => r.level === 5);
    await assert.rejects(() => loader.loadNocRows(unitsOnly, 'fixture'), /has no parent/);
    assert.equal(await db.occupation.count({ where: { slug: { startsWith: 'noc2021-' } } }), 0, 'the transaction rolled back: nothing half-loaded');
  });

  it('loads the attributed fixture under an approved licence: tree, codes, TEER and both locales; idempotent', async () => {
    await datasets.recordDatasetLicence(
      'fixture',
      { licenceName: 'Test fixture', licenceUrl: '', attribution: 'Structure follows Statistics Canada NOC 2021 V1.0 (test fixture)', status: 'recorded', ingestionApproved: true },
      STAFF,
      'Test: fixture approved',
    );
    const labelsBefore = await db.occupationLabel.count();
    const first = await loader.loadNocRows(rows(), 'fixture');
    assert.equal(first.occupations, 19);
    assert.equal(first.codes, 19);
    assert.equal(first.labels, 38);
    assert.equal((await db.occupationLabel.count()) - labelsBefore, 38, 'the report counts what was written');
    const second = await loader.loadNocRows(rows(), 'fixture');
    assert.deepEqual(second, { datasetKey: 'fixture', occupations: 0, labels: 0, codes: 0 });

    const unit = await db.occupation.findUniqueOrThrow({ where: { slug: 'noc2021-21223' }, include: { parent: true, codes: true, labels: true } });
    assert.equal(unit.level, 'unit');
    assert.equal(unit.parent?.slug, 'noc2021-2122');
    assert.equal(unit.codes[0].teer, 1);
    assert.deepEqual(unit.labels.map((l) => l.locale).sort(), ['en', 'fr']);
    const fr = unit.labels.find((l) => l.locale === 'fr')!;
    assert.equal(fr.normalizedTitle, 'analystes de bases de données et administrateurs administratrices de données');
    assert.deepEqual(JSON.parse(fr.normalizedAlternates), ['analyste de données']);
    const broad = await db.occupation.findUniqueOrThrow({ where: { slug: 'noc2021-2' } });
    assert.equal(broad.parentId, null);
    const dataset = await db.taxonomyDataset.findUniqueOrThrow({ where: { key: 'fixture' } });
    assert.equal(dataset.rowCount, 19);
    assert.ok(dataset.ingestedAt);
  });

  it('the integrity report: no orphans, both locales complete, every unit group lacks SOC until the crosswalk loads', async () => {
    // Scoped to this suite's dataset: another suite may hold occupations of its own at the same time.
    const fixture = await db.taxonomyDataset.findUniqueOrThrow({ where: { key: 'fixture' } });
    const report = await queries.completeness(db, ['en', 'fr'], { datasetId: fixture.id });
    assert.equal(report.occupations, 19);
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

  it('classification records its method: exact title, alternate title, regex fallback, none — on punctuation-heavy real titles', async () => {
    const exact = await classify.classifyTitle('Data Scientists');
    assert.equal(exact.method, 'title_exact');
    assert.equal(exact.nocCode, '21211');
    const fr = await classify.classifyTitle('Scientifiques des données');
    assert.equal(fr.method, 'title_exact');
    assert.equal(fr.occupationId, exact.occupationId);
    // Real NOC French titles carry slashes; a posting writes one form.
    const slashes = await classify.classifyTitle('Développeurs/développeuses et programmeurs/programmeuses Web');
    assert.equal(slashes.method, 'title_exact');
    assert.equal(slashes.nocCode, '21234');
    const apostrophe = await classify.classifyTitle("Analyste d'affaires");
    assert.equal(apostrophe.method, 'title_alternate');
    assert.equal(apostrophe.nocCode, '21221');
    // Hyphens inside a title are not separators.
    const hyphen = await classify.classifyTitle('Senior Full-Stack Developer (Toronto)');
    assert.equal(hyphen.method, 'title_alternate');
    assert.equal(hyphen.nocCode, '21232');
    const head = await classify.classifyTitle('Business Analyst, Payments');
    assert.equal(head.method, 'title_alternate');
    assert.equal(head.nocCode, '21221');
    // A category title never classifies a posting: only unit groups match by title.
    const category = await classify.classifyTitle('Computer and information systems professionals');
    assert.equal(category.method, 'none');
    const regex = await classify.classifyTitle('Information Security Manager');
    assert.equal(regex.method, 'regex_fallback');
    assert.equal(regex.confidence, 'low');
    assert.equal(regex.nocCode, '21220');
    const none = await classify.classifyTitle('Head of Growth');
    assert.deepEqual(none, { occupationId: null, method: 'none', confidence: 'none', nocCode: null });
    const chief = await classify.classifyTitle('Chief of Staff');
    assert.equal(chief.method, 'none');
  });

  it('a stored posting is classified once, a high-confidence result overwrites the capture-time guess, and nothing runs on an empty spine', async () => {
    const job = await db.job.create({
      data: { source: 'test', externalId: `tax_${S}`, title: 'Machine Learning Engineer', company: 'Co', location: 'Toronto', country: 'CA', description: '', requirements: '[]', skills: '[]', applyUrl: 'https://example.test', postedAt: new Date(), nocCode: '21231' },
    });
    const result = await classify.classifyStoredJob(job);
    assert.equal(result?.method, 'title_alternate');
    const stored = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(stored.occupationSource, 'title_alternate');
    assert.equal(stored.nocCode, '21211', 'the regex guess 21231 was replaced by the classified 21211');
    assert.equal(await classify.classifyStoredJob(stored), null, 'already classified: no second pass');
    await db.job.delete({ where: { id: job.id } });
  });

  it('search finds by title in either locale, by alternate title, and by code', async () => {
    assert.ok((await queries.searchOccupations(db, 'cyber')).some((o) => o.slug === 'noc2021-21220'));
    assert.ok((await queries.searchOccupations(db, 'cybersécurité')).some((o) => o.slug === 'noc2021-21220'));
    assert.ok((await queries.searchOccupations(db, 'Programmer')).some((o) => o.slug === 'noc2021-21232'));
    assert.ok((await queries.searchOccupations(db, '2122')).some((o) => o.slug === 'noc2021-2122'));
    assert.deepEqual(await queries.searchOccupations(db, '   '), []);
  });

  it('withdrawing approval or prohibiting a loaded dataset purges its rows: nothing keeps serving', async () => {
    const before = await db.occupation.count({ where: { slug: { startsWith: 'noc2021-' } } });
    assert.equal(before, 19);
    const decision = await datasets.recordDatasetLicence('soc-2018', { licenceName: 'US public domain (test)', attribution: 'x', status: 'prohibited', ingestionApproved: false }, STAFF, 'Test: SOC withdrawn');
    assert.equal(decision.purged.codes, 5);
    assert.equal(await db.occupationCode.count({ where: { scheme: 'SOC2018' } }), 0);
    assert.deepEqual(await queries.crosswalk(db, { scheme: 'NOC2021', code: '21223' }, 'SOC2018'), []);
    assert.equal(decision.dataset.rowCount, 0);
    assert.equal(decision.dataset.ingestedAt, null);
    // Re-record and reload for the remaining cases.
    await datasets.recordDatasetLicence('soc-2018', { licenceName: 'US public domain (test)', attribution: 'SOC 2018, U.S. BLS (test fixture)', status: 'recorded', ingestionApproved: true }, STAFF, 'Test: SOC re-approved');
    await loader.loadSocCrosswalk([{ noc: '21223', soc: '15-2051' }], 'soc-2018');
    // Withdrawing approval on the NOC fixture purges every occupation it introduced; jobs lose the link.
    const job = await db.job.create({ data: { source: 'test', externalId: `tax2_${S}`, title: 'Data Scientists', company: 'Co', location: 'Toronto', country: 'CA', description: '', requirements: '[]', skills: '[]', applyUrl: 'https://example.test', postedAt: new Date() } });
    await classify.classifyStoredJob(job);
    assert.ok((await db.job.findUniqueOrThrow({ where: { id: job.id } })).occupationId);
    const withdrawn = await datasets.recordDatasetLicence('fixture', { licenceName: 'Test fixture', attribution: 'Fixture attribution', status: 'recorded', ingestionApproved: false }, STAFF, 'Test: approval withdrawn');
    assert.equal(withdrawn.purged.occupations, 19);
    assert.equal(await db.occupation.count({ where: { slug: { startsWith: 'noc2021-' } } }), 0);
    assert.equal((await db.job.findUniqueOrThrow({ where: { id: job.id } })).occupationId, null);
    assert.equal(await classify.classifyStoredJob({ ...job, occupationId: null }), null, 'an empty spine classifies nothing');
    await db.job.delete({ where: { id: job.id } });
    // Reload for the RLS case below.
    await datasets.recordDatasetLicence('fixture', { licenceName: 'Test fixture', attribution: 'Fixture attribution', status: 'recorded', ingestionApproved: true }, STAFF, 'Test: fixture re-approved');
    await loader.loadNocRows(rows(), 'fixture');
  });

  it('the tenant path reads the spine (no filter) and cannot write it; the dataset register is not readable at all', async () => {
    const seen = await ctx.withTenant({ userId: USER.id }, (tx) => tx.occupation.count({ where: { slug: { startsWith: 'noc2021-' } } }));
    assert.equal(seen, 19);
    // System-only: a forced table with no tenant policy shows the tenant NOTHING (a SELECT is empty, not an error).
    assert.deepEqual(await ctx.withTenant({ userId: USER.id }, (tx) => tx.taxonomyDataset.findMany()), []);
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
    const flipped = await ctx.withTenant({ userId: USER.id }, (tx) => tx.taxonomyDataset.updateMany({ where: { key: 'onet' }, data: { ingestionApproved: true } }));
    assert.equal(flipped.count, 0, 'a tenant cannot open the licence gate');
    assert.equal((await db.taxonomyDataset.findUniqueOrThrow({ where: { key: 'onet' } })).ingestionApproved, false);
  });
});
