/**
 * Stage 05 — the acquisition pipeline and the source register against the
 * migrated PostgreSQL: the enablement gate (registered, enabled, record
 * complete, credentials present), discovery with first/last-seen and
 * immutable snapshots, refresh with honest closure, health, and the audit
 * of every run including refused ones.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

const CONNECTION_STRING = process.env.TENANCY_TEST_DATABASE_URL;
const REQUIRED = process.env.CI === 'true' || process.env.RLS_TEST_REQUIRED === '1';
if (!CONNECTION_STRING && REQUIRED) throw new Error('TENANCY_TEST_DATABASE_URL is required here (see ci.yml).');
const SKIP = CONNECTION_STRING ? false : 'TENANCY_TEST_DATABASE_URL is not set. REQUIRED in CI.';

type Db = typeof import('../src/lib/db')['db'];
type Registry = typeof import('../src/lib/connectors/registry');
type Pipeline = typeof import('../src/lib/connectors/pipeline');
type Ctx = typeof import('../src/lib/tenancy/context');
const S = randomBytes(4).toString('hex');
const STAFF = { id: `src_staff_${S}`, email: `src-${S}@src.test`, fullName: 'Staff', role: 'admin' as const, storedRole: 'admin' };
const USER = { id: `src_user_${S}`, email: `src-user-${S}@src.test` };
let db: Db;
let registry: Registry;
let pipeline: Pipeline;
let ctx: Ctx;

const query = { titles: ['Data Analyst'], locations: ['Toronto'], country: 'CA' as const, limit: 5 };

describe('Stage 05 — source register gate and pipeline', { skip: SKIP }, () => {
  before(async () => {
    process.env.DATABASE_URL = CONNECTION_STRING;
    ({ db } = await import('../src/lib/db'));
    registry = await import('../src/lib/connectors/registry');
    pipeline = await import('../src/lib/connectors/pipeline');
    ctx = await import('../src/lib/tenancy/context');
    await db.user.create({ data: { id: USER.id, email: USER.email, passwordHash: 'x', fullName: 'Tenant' } });
    await registry.ensureSourceRegistry();
    // Reset what this suite touches: the adzuna row's governance state and the mock's run history counters.
    await db.jobSource.update({ where: { key: 'adzuna' }, data: { status: 'disabled', legalBasis: '', termsReviewedAt: null, termsReviewedByEmail: null, approvedAt: null, approvedByEmail: null, retentionRef: 'DATA_RETENTION_MATRIX.md — Job postings & snapshots' } });
    delete process.env.ADZUNA_APP_ID;
    delete process.env.ADZUNA_APP_KEY;
  });
  after(async () => {
    await db.jobSource.update({ where: { key: 'adzuna' }, data: { status: 'disabled', legalBasis: '', termsReviewedAt: null, termsReviewedByEmail: null, approvedAt: null, approvedByEmail: null } });
    await db.user.deleteMany({ where: { id: USER.id } });
    await db.auditLog.deleteMany({ where: { actorId: STAFF.id } });
    await db.$disconnect();
  });

  it('the register: mock enabled with a complete record; adzuna disabled with credential NAMES and an empty legal basis', async () => {
    const mock = await db.jobSource.findUniqueOrThrow({ where: { key: 'mock' } });
    assert.equal(mock.status, 'enabled');
    assert.ok(registry.recordComplete(mock));
    const adzuna = await db.jobSource.findUniqueOrThrow({ where: { key: 'adzuna' } });
    assert.equal(adzuna.status, 'disabled');
    assert.equal(registry.recordComplete(adzuna), false);
    assert.deepEqual(JSON.parse(adzuna.credentialEnvVars), ['ADZUNA_APP_ID', 'ADZUNA_APP_KEY']);
    assert.deepEqual(registry.missingCredentials(adzuna), ['ADZUNA_APP_ID', 'ADZUNA_APP_KEY']);
  });

  it('the gate refuses an unknown, a disabled, an incomplete and an uncredentialed source — and records the refusal', async () => {
    await assert.rejects(() => pipeline.runDiscovery('nope', query), /not a known connector/);
    await assert.rejects(() => pipeline.runDiscovery('adzuna', query), /disabled/);
    const refused = await db.jobSourceRun.findFirst({ where: { source: { key: 'adzuna' }, status: 'refused' }, orderBy: { startedAt: 'desc' } });
    assert.ok(refused);
    assert.match(refused.error ?? '', /disabled/);
    // Enabling requires a complete record AND credentials; neither can be skipped.
    await assert.rejects(
      () => registry.recordSourcePolicy('adzuna', { legalBasis: '', retentionRef: 'x', action: 'enable' }, STAFF, 'test'),
      /incomplete/,
    );
    await assert.rejects(
      () => registry.recordSourcePolicy('adzuna', { legalBasis: 'API terms reviewed (test)', retentionRef: 'x', action: 'enable' }, STAFF, 'test'),
      /missing credential/,
    );
    await assert.rejects(() => registry.recordSourcePolicy('adzuna', { legalBasis: 'x', retentionRef: 'x', action: 'record' }, STAFF, ''), /reason/);
    // Record only: the review is stored, the source stays disabled.
    const recorded = await registry.recordSourcePolicy('adzuna', { legalBasis: 'API terms reviewed (test)', retentionRef: 'x', action: 'record' }, STAFF, 'Test: terms reviewed');
    assert.equal(recorded.status, 'disabled');
    assert.equal(recorded.termsReviewedByEmail, STAFF.email);
    assert.equal(recorded.approvedAt, null, 'recording is not approval');
    await assert.rejects(() => pipeline.runDiscovery('adzuna', query), /disabled/);
    // With credentials present, enabling completes the record with the approver.
    process.env.ADZUNA_APP_ID = 'test-id';
    process.env.ADZUNA_APP_KEY = 'test-key';
    const enabled = await registry.recordSourcePolicy('adzuna', { legalBasis: 'API terms reviewed (test)', retentionRef: 'x', action: 'enable' }, STAFF, 'Test: enabled');
    assert.equal(enabled.status, 'enabled');
    assert.equal(enabled.approvedByEmail, STAFF.email);
    assert.ok(registry.recordComplete(enabled));
    // Credentials removed later: the gate refuses at run time even though the row says enabled.
    delete process.env.ADZUNA_APP_ID;
    await assert.rejects(() => pipeline.runDiscovery('adzuna', query), /missing credential\(s\) ADZUNA_APP_ID/);
    delete process.env.ADZUNA_APP_KEY;
    const disabled = await registry.recordSourcePolicy('adzuna', { legalBasis: 'API terms reviewed (test)', retentionRef: 'x', action: 'disable' }, STAFF, 'Test: disabled again');
    assert.equal(disabled.status, 'disabled');
    const audit = await db.auditLog.findMany({ where: { entityType: 'JobSource', actorId: STAFF.id }, orderBy: { createdAt: 'asc' } });
    assert.deepEqual(audit.map((a) => a.action), ['source.policy.recorded', 'source.enabled', 'source.disabled']);
  });

  it('discovery: postings are normalised, validated, upserted with first/last seen, snapshotted once per content, and the run is audited', async () => {
    const first = await pipeline.runDiscovery('mock', query);
    assert.equal(first.run.status, 'ok');
    assert.ok(first.run.discovered > 0);
    assert.equal(first.jobIds.length, first.run.created + first.run.updated);
    assert.equal(JSON.parse(first.run.meta).query.titles, 1, 'the run records the query SHAPE');
    assert.equal(JSON.stringify(first.run.meta).includes('Data Analyst'), false, 'never the query text');
    const job = await db.job.findUniqueOrThrow({ where: { id: first.jobIds[0] }, include: { snapshots: true, jobSource: true } });
    assert.equal(job.jobSource?.key, 'mock');
    assert.equal(job.activeState, 'active');
    // The job may predate this run (a shared database): what is asserted is
    // that the CURRENT content has exactly one snapshot and nothing grows on
    // an unchanged re-capture.
    const initial = job.snapshots.length;
    assert.ok(initial >= 1);
    const current = job.snapshots.find((sn) => sn.sourceHash === job.sourceHash)!;
    assert.ok(current);
    assert.equal(JSON.parse(current.payload).title, job.title);

    // Same content again: last seen moves, no new snapshot.
    const second = await pipeline.runDiscovery('mock', query);
    assert.equal(second.run.created, 0);
    assert.ok(second.run.updated > 0);
    const again = await db.job.findUniqueOrThrow({ where: { id: first.jobIds[0] }, include: { snapshots: true } });
    assert.equal(again.snapshots.length, initial);
    assert.ok(again.lastSeenAt.getTime() >= job.lastSeenAt.getTime());

    // Changed content: a new snapshot, the old one untouched and immutable.
    const source = await db.jobSource.findUniqueOrThrow({ where: { key: 'mock' } });
    const payload = JSON.parse(current.payload);
    await pipeline.upsertPosting(source, { ...payload, description: `${payload.description}\nUPDATED ${S}` });
    const changed = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { snapshots: { orderBy: { capturedAt: 'asc' } } } });
    assert.equal(changed.snapshots.length, initial + 1);
    const latest = changed.snapshots[changed.snapshots.length - 1];
    assert.notEqual(latest.sourceHash, current.sourceHash);
    assert.equal(changed.sourceHash, latest.sourceHash);
    await assert.rejects(() => db.jobSnapshot.update({ where: { id: current.id }, data: { payload: '{}' } }), /immutable/);
    const mockRow = await db.jobSource.findUniqueOrThrow({ where: { key: 'mock' } });
    assert.ok(mockRow.lastSuccessAt);
    assert.equal(mockRow.errorCount, 0);
  });

  it('refresh: closed postings close, active ones are re-seen, unknown stays unknown — never inferred', async () => {
    const source = await db.jobSource.findUniqueOrThrow({ where: { key: 'mock' } });
    const stale = new Date(Date.now() - 3 * 86_400_000);
    const ghost = await db.job.create({ data: { source: 'mock', externalId: `ghost_${S}`, title: 'Ghost', company: 'Co', location: 'Toronto', country: 'CA', description: '', requirements: '[]', skills: '[]', applyUrl: 'https://example.test', postedAt: stale, sourceId: source.id, lastSeenAt: stale } });
    const live = (await db.job.findFirst({ where: { sourceId: source.id, externalId: { startsWith: 'mock-' } }, orderBy: { lastSeenAt: 'desc' } }))!;
    await db.job.update({ where: { id: live.id }, data: { lastSeenAt: stale } });
    const run = await pipeline.runRefresh('mock', { staleAfterMs: 86_400_000 });
    assert.equal(run.status, 'ok');
    assert.ok(run.closed >= 1);
    const g = await db.job.findUniqueOrThrow({ where: { id: ghost.id } });
    assert.equal(g.activeState, 'closed');
    assert.ok(g.closedAt);
    const l = await db.job.findUniqueOrThrow({ where: { id: live.id } });
    assert.equal(l.activeState, 'active');
    assert.ok(l.lastSeenAt.getTime() > stale.getTime());
    await db.job.delete({ where: { id: ghost.id } });
  });

  it('health: runs for a disabled source (so an operator can learn it is safe to enable) and reports missing credentials as down', async () => {
    const adzuna = await pipeline.runHealthCheck('adzuna');
    assert.equal(adzuna.report.status, 'down');
    assert.match(adzuna.report.detail, /missing credential/);
    assert.equal(adzuna.source.lastHealthStatus, 'down');
    const mock = await pipeline.runHealthCheck('mock');
    assert.equal(mock.report.status, 'ok');
    await assert.rejects(() => pipeline.runHealthCheck('nope'), /Unknown job source/);
  });

  it('tenants read jobs and snapshots, and cannot read the source register or the run audit', async () => {
    const snapshots = await ctx.withTenant({ userId: USER.id }, (tx) => tx.jobSnapshot.count());
    assert.ok(snapshots > 0);
    assert.deepEqual(await ctx.withTenant({ userId: USER.id }, (tx) => tx.jobSource.findMany()), []);
    assert.deepEqual(await ctx.withTenant({ userId: USER.id }, (tx) => tx.jobSourceRun.findMany()), []);
    await assert.rejects(
      () => ctx.withTenant({ userId: USER.id }, (tx) => tx.jobSnapshot.create({ data: { jobId: 'x', sourceHash: 'x', payload: '{}' } })),
      /row-level security|42501|permission denied|foreign key/,
    );
  });
});
