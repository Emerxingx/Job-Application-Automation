/**
 * Stage 09 — document versions against the database and the object store.
 *
 * Proves: a stored version is byte-reproducible (the bytes come back equal
 * and hash-verified, and an altered or missing object is refused, never
 * served); the application set (résumé + letter × TXT/PDF/DOCX) is written
 * with ATS reports and re-renders to the same hashes; a submitted version is
 * immutable BY THE DATABASE (UPDATE and direct DELETE refused) while account
 * erasure still cascades; confirming an assisted application seals its
 * drafts; a tenant reads and writes only their own rows.
 */
import './helpers/database-env';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const CONNECTION_STRING = process.env.TENANCY_TEST_DATABASE_URL;
const REQUIRED = process.env.CI === 'true' || process.env.RLS_TEST_REQUIRED === '1';
if (!CONNECTION_STRING && REQUIRED) throw new Error('TENANCY_TEST_DATABASE_URL is required here (see ci.yml).');
const SKIP = CONNECTION_STRING ? false : 'TENANCY_TEST_DATABASE_URL is not set. REQUIRED in CI.';

type Db = typeof import('../src/lib/db')['db'];
type Versions = typeof import('../src/lib/documents/versions');
type AppDocs = typeof import('../src/lib/documents/application-documents');
type Storage = typeof import('../src/lib/storage');
type Ctx = typeof import('../src/lib/tenancy/context');
type Applicator = typeof import('../src/lib/services/applicator');
type Model = typeof import('../src/lib/documents/model');

const S = randomBytes(4).toString('hex');
const A = { id: `dv_a_${S}`, email: `dv-a-${S}@docs.test` };
const B = { id: `dv_b_${S}`, email: `dv-b-${S}@docs.test` };
const RESUME = {
  fullName: 'Doc Candidate',
  headline: 'Data Analyst',
  email: A.email,
  location: 'Toronto, ON',
  summary: 'Analyst with SQL and Python.',
  skills: ['SQL', 'Python'],
  experience: [{ company: 'Old Co', title: 'Data Analyst', startDate: '2021-01', endDate: 'Present', bullets: ['Built SQL reporting'] }],
  education: [],
  certifications: [],
  projects: [],
};
const root = mkdtempSync(path.join(tmpdir(), 'jp-docs-'));
let db: Db;
let versions: Versions;
let appDocs: AppDocs;
let storage: Storage;
let ctx: Ctx;
let applicator: Applicator;
let model: Model;
let jobId: string;

describe('Stage 09 — document versions against the database', { skip: SKIP }, () => {
  before(async () => {
    process.env.DATABASE_URL = CONNECTION_STRING;
    process.env.STORAGE_ROOT = root;
    delete process.env.STORAGE_PROVIDER;
    ({ db } = await import('../src/lib/db'));
    storage = await import('../src/lib/storage');
    storage.resetStorageProviderForTests();
    versions = await import('../src/lib/documents/versions');
    appDocs = await import('../src/lib/documents/application-documents');
    ctx = await import('../src/lib/tenancy/context');
    applicator = await import('../src/lib/services/applicator');
    model = await import('../src/lib/documents/model');
    for (const u of [A, B]) await db.user.create({ data: { id: u.id, email: u.email, passwordHash: 'x', fullName: 'Docs', country: 'CA' } });
    const job = await db.job.create({ data: { source: 'mock', externalId: `dv-${S}`, title: 'Data Analyst', company: `Maple ${S}`, location: 'Toronto, ON', description: 'SQL and Python.', requirements: '[]', skills: JSON.stringify(['sql', 'python']), postedAt: new Date() } });
    jobId = job.id;
  });
  after(async () => {
    await db.user.deleteMany({ where: { id: { in: [A.id, B.id] } } });
    await db.job.deleteMany({ where: { id: jobId } });
    await db.$disconnect();
    rmSync(root, { recursive: true, force: true });
  });

  it('records a version with its hash, numbers the next one, and reads the bytes back verified', async () => {
    const bytes = Buffer.from(`hello ${S}`, 'utf8');
    const v1 = await versions.recordDocumentVersion(db, { userId: A.id, jobId, kind: 'outreach', format: 'txt', bytes });
    assert.equal(v1.version, 1);
    assert.equal(v1.scopeKey, `job:${jobId}`);
    assert.equal(v1.contentHash, versions.sha256(bytes));
    assert.equal(v1.sizeBytes, bytes.length);
    assert.equal(v1.status, 'draft');
    assert.equal(v1.storageKey, `${A.id}/documents/job:${jobId}/outreach-v1.txt`);
    const v2 = await versions.recordDocumentVersion(db, { userId: A.id, jobId, kind: 'outreach', format: 'txt', bytes: Buffer.from('second') });
    assert.equal(v2.version, 2);
    assert.ok((await versions.readDocumentBytes(v1)).equals(bytes));
  });

  it('refuses to serve an altered or missing object: byte-reproducible or nothing', async () => {
    const bytes = Buffer.from('original');
    const row = await versions.recordDocumentVersion(db, { userId: A.id, kind: 'follow_up', format: 'txt', bytes });
    const store = await storage.getStorageProvider();
    await store.putBytes(row.storageKey, Buffer.from('tampered'), 'text/plain');
    await assert.rejects(() => versions.readDocumentBytes(row), (e: Error) => e instanceof versions.DocumentIntegrityError && /does not match/.test(e.message));
    rmSync(path.join(root, row.storageKey));
    await assert.rejects(() => versions.readDocumentBytes(row), /missing/);
  });

  it('writes the application set (résumé + letter × TXT/PDF/DOCX) with ATS reports, and each file re-renders to the same hash', async () => {
    const application = await db.application.create({ data: { userId: A.id, jobId, status: 'submitted', appliedAt: new Date() } });
    const createdAt = new Date('2026-09-03T12:00:00Z');
    const rows = await appDocs.writeApplicationDocuments({ userId: A.id, applicationId: application.id, jobId, author: RESUME.fullName, company: 'Maple', resume: RESUME, coverLetter: 'Dear Hiring Team,\n\nI am applying.\n\nDoc Candidate', evidenceIds: ['ev1'], createdAt, seal: true });
    assert.deepEqual(rows.map((r) => `${r.kind}.${r.format}`).sort(), ['cover_letter.docx', 'cover_letter.pdf', 'cover_letter.txt', 'resume.docx', 'resume.pdf', 'resume.txt']);
    for (const r of rows) {
      assert.equal(r.status, 'submitted');
      assert.ok(r.sealedAt);
      const report = JSON.parse(r.atsReport) as { ok: boolean; checks: { name: string; ok: boolean }[] };
      assert.equal(report.ok, true, `${r.kind}.${r.format}: ${JSON.stringify(report.checks.filter((c) => !c.ok))}`);
      assert.ok(report.checks.some((c) => c.name === 'parse_back' && c.ok), 'the rendered file parses back');
      const stored = await versions.readDocumentBytes(r);
      assert.equal(versions.sha256(stored), r.contentHash);
    }
    // Byte reproducibility: the same model and date render to the same bytes the store holds.
    const again = await appDocs.renderDocumentSet(model.resumeModel(RESUME), { author: RESUME.fullName, createdAt });
    for (const rendered of again) {
      const row = rows.find((r) => r.kind === 'resume' && r.format === rendered.format)!;
      assert.equal(versions.sha256(rendered.bytes), row.contentHash, `resume.${rendered.format} reproducible`);
    }
    const text = rows.find((r) => r.kind === 'resume' && r.format === 'txt')!;
    assert.equal((await versions.readDocumentBytes(text)).toString('utf8'), model.renderText(model.resumeModel(RESUME)));
  });

  it('a submitted version is immutable by the database: UPDATE and direct DELETE are refused; erasure still cascades', async () => {
    const application = await db.application.create({ data: { userId: B.id, jobId, status: 'submitted', appliedAt: new Date() } });
    const row = await versions.recordDocumentVersion(db, { userId: B.id, applicationId: application.id, jobId, kind: 'resume', format: 'txt', bytes: Buffer.from('sealed') });
    assert.equal(await versions.sealApplicationDocuments(db, B.id, application.id), 1);
    assert.equal(await versions.sealApplicationDocuments(db, B.id, application.id), 0, 'idempotent');
    await assert.rejects(() => db.$executeRawUnsafe('UPDATE "DocumentVersion" SET "contentHash" = $1 WHERE id = $2', 'forged', row.id), /immutable/);
    await assert.rejects(() => db.$executeRawUnsafe('UPDATE "DocumentVersion" SET "status" = $1 WHERE id = $2', 'draft', row.id), /immutable/);
    await assert.rejects(() => db.documentVersion.update({ where: { id: row.id }, data: { storageKey: 'elsewhere' } }), /immutable/);
    await assert.rejects(() => db.$executeRawUnsafe('DELETE FROM "DocumentVersion" WHERE id = $1', row.id), /cannot be deleted directly/);
    await assert.rejects(() => db.documentVersion.delete({ where: { id: row.id } }), /cannot be deleted directly/);
    assert.equal(await db.documentVersion.count({ where: { id: row.id } }), 1);
    // The owner's erasure cascades through the guard.
    await db.user.delete({ where: { id: B.id } });
    assert.equal(await db.documentVersion.count({ where: { userId: B.id } }), 0);
    await db.user.create({ data: { id: B.id, email: B.email, passwordHash: 'x', fullName: 'Docs', country: 'CA' } });
  });

  it('confirming an assisted application seals what was prepared', async () => {
    const application = await db.application.create({ data: { userId: A.id, jobId: (await db.job.create({ data: { source: 'mock', externalId: `dv2-${S}`, title: 'Analyst', company: 'Birch', location: 'Toronto', description: 'x', postedAt: new Date() } })).id, status: 'ready_to_submit' } });
    const row = await versions.recordDocumentVersion(db, { userId: A.id, applicationId: application.id, kind: 'cover_letter', format: 'txt', bytes: Buffer.from('prepared') });
    assert.equal(row.status, 'draft');
    const result = await applicator.confirmAssistedSubmission(A.id, application.id);
    assert.deepEqual(result, { ok: true });
    const sealed = await db.documentVersion.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(sealed.status, 'submitted');
    assert.ok(sealed.sealedAt);
  });

  it('tenants read and write only their own versions', async () => {
    const mine = await ctx.withTenant({ userId: A.id }, (tx) => versions.recordDocumentVersion(tx, { userId: A.id, kind: 'thank_you', format: 'txt', bytes: Buffer.from('thanks') }));
    assert.equal(mine.userId, A.id);
    const seen = await ctx.withTenant({ userId: A.id }, (tx) => versions.listDocumentVersions(tx, A.id));
    assert.ok(seen.some((d) => d.id === mine.id));
    assert.ok(seen.every((d) => d.userId === A.id));
    assert.deepEqual(await ctx.withTenant({ userId: B.id }, (tx) => tx.documentVersion.findMany({ where: { userId: A.id } })), [], 'another tenant sees nothing');
    await assert.rejects(() => ctx.withTenant({ userId: B.id }, (tx) => versions.recordDocumentVersion(tx, { userId: A.id, kind: 'thank_you', format: 'txt', bytes: Buffer.from('forged') })), /row-level security/);
  });
});
