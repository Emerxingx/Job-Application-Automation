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
    // Refusals are tenant-driven and coalesced: the several refused
    // discoveries above left ONE refused row for the window, not one each.
    const window = new Date(Date.now() - pipeline.REFUSAL_WINDOW_MS);
    assert.equal(await db.jobSourceRun.count({ where: { source: { key: 'adzuna' }, kind: 'discover', status: 'refused', startedAt: { gte: window } } }), 1);
  });

  it('two runs racing on a NEW posting: the loser becomes an update, never a failed run, and the job has exactly one snapshot', async () => {
    const source = await db.jobSource.findUniqueOrThrow({ where: { key: 'mock' } });
    const { MockConnector } = await import('../src/lib/connectors/mock');
    const c = new MockConnector();
    const [raw] = await c.discover(query);
    // A canonical identity of its own: a copy of a catalogue posting would be
    // (correctly) merged into that job by Stage 06 dedup rather than created.
    const posting = { ...c.normalize(raw), externalId: `mock-race-${S}`, title: `Race Engineer ${S}`, company: `Race Co ${S}` };
    const results = await Promise.all([1, 2, 3].map(() => pipeline.upsertPosting(source, posting)));
    const ids = new Set(results.map((r) => r.id));
    assert.equal(ids.size, 1, 'all three resolved to the same row');
    assert.equal(results.filter((r) => r.isNew).length, 1, 'exactly one created it');
    const job = await db.job.findUniqueOrThrow({ where: { id: results[0].id }, include: { snapshots: true } });
    assert.equal(job.snapshots.length, 1);
    await db.job.delete({ where: { id: job.id } });
  });

  it('run outcomes move the source between enabled and degraded on the database\'s current state, never on a stale copy; disabled is never overridden', async () => {
    const mock = await db.jobSource.findUniqueOrThrow({ where: { key: 'mock' } });
    const runFor = () => db.jobSourceRun.create({ data: { sourceId: mock.id, kind: 'discover', meta: '{}' } });
    try {
      await db.jobSource.update({ where: { id: mock.id }, data: { status: 'enabled', errorCount: 0 } });
      for (let n = 1; n <= pipeline.DEGRADE_AFTER_FAILURES; n += 1) {
        await pipeline.finishRun(await runFor(), { status: 'failed', errorCount: 1, error: `boom ${n}` }, mock);
        const row = await db.jobSource.findUniqueOrThrow({ where: { id: mock.id } });
        assert.equal(row.errorCount, n);
        assert.equal(row.status, n < pipeline.DEGRADE_AFTER_FAILURES ? 'enabled' : 'degraded', `after failure ${n}`);
      }
      // `mock` here is the STALE copy (status enabled, errorCount 0): the
      // recovery must still apply because the ROW is degraded.
      await pipeline.finishRun(await runFor(), { status: 'ok', discovered: 1 }, mock);
      let row = await db.jobSource.findUniqueOrThrow({ where: { id: mock.id } });
      assert.equal(row.status, 'enabled');
      assert.equal(row.errorCount, 0);
      assert.equal(row.lastError, null);
      // An admin disabled the source while a run was in flight: the run's
      // success must not re-enable it (the copy the run holds says degraded).
      await db.jobSource.update({ where: { id: mock.id }, data: { status: 'disabled' } });
      await pipeline.finishRun(await runFor(), { status: 'ok', discovered: 1 }, { ...mock, status: 'degraded' });
      row = await db.jobSource.findUniqueOrThrow({ where: { id: mock.id } });
      assert.equal(row.status, 'disabled', 'the pipeline never flips status on its own authority');
    } finally {
      await db.jobSource.update({ where: { id: mock.id }, data: { status: 'enabled', errorCount: 0, lastError: null } });
    }
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
    // Stage 06: staleness is per source PROVENANCE, so each fixture job carries one.
    const plant = async (externalId: string, title: string) => {
      const job = await db.job.create({ data: { source: 'mock', externalId, title, company: 'Co', location: 'Toronto', country: 'CA', description: '', requirements: '[]', skills: '[]', applyUrl: 'https://example.test', postedAt: stale, sourceId: source.id, lastSeenAt: stale, canonicalHash: `h_${externalId}` } });
      await db.jobProvenance.create({ data: { jobId: job.id, sourceId: source.id, externalId, firstSeenAt: stale, lastSeenAt: stale } });
      return job;
    };
    // A mock-shaped id the catalogue no longer lists: the source KNOWS it is gone.
    const ghost = await plant(`mock-ghost_${S}`, 'Ghost');
    // An id the source cannot speak for: the honest answer is unknown, and the pipeline records exactly that.
    const stranger = await plant(`foreign_${S}`, 'Stranger');
    const live = (await db.job.findFirst({ where: { sourceId: source.id, externalId: { startsWith: 'mock-' }, provenance: { some: { sourceId: source.id } } }, orderBy: { lastSeenAt: 'desc' } }))!;
    await db.job.update({ where: { id: live.id }, data: { lastSeenAt: stale } });
    // Outside the ask window too (a previous run of this suite may have asked about it).
    await db.jobProvenance.updateMany({ where: { jobId: live.id, sourceId: source.id }, data: { lastSeenAt: stale, lastCheckedAt: null } });
    const run = await pipeline.runRefresh('mock', { staleAfterMs: 86_400_000 });
    assert.equal(run.status, 'ok');
    assert.ok(run.closed >= 1);
    const g = await db.job.findUniqueOrThrow({ where: { id: ghost.id } });
    assert.equal(g.activeState, 'closed');
    assert.ok(g.closedAt);
    const l = await db.job.findUniqueOrThrow({ where: { id: live.id } });
    assert.equal(l.activeState, 'active');
    assert.ok(l.lastSeenAt.getTime() > stale.getTime());
    const u = await db.job.findUniqueOrThrow({ where: { id: stranger.id } });
    assert.equal(u.activeState, 'unknown', 'silence is recorded as unknown');
    assert.equal(u.closedAt, null, 'never inferred as closed');
    assert.equal(u.lastSeenAt.getTime(), stale.getTime(), 'and not re-seen either');
    await db.job.deleteMany({ where: { id: { in: [ghost.id, stranger.id] } } });
  });

  it('Stage 06 dedup: the same posting from two sources is ONE job with TWO provenance rows and a snapshot per capture; the second source never overwrites the first', async () => {
    const mock = await db.jobSource.findUniqueOrThrow({ where: { key: 'mock' } });
    const adzuna = await db.jobSource.findUniqueOrThrow({ where: { key: 'adzuna' } });
    const base = { companyLogo: undefined, salaryMin: 90000, salaryMax: 110000, salaryCurrency: 'CAD', nocCode: undefined, applyMethod: 'external' as const, postedAt: '2026-09-01T00:00:00.000Z', requirements: [], skills: [], country: 'CA' as const, workMode: 'hybrid' as const, jobType: 'full_time' as const };
    // The employer carries the run id so the canonical identity is this run's own (a shared database keeps rows from aborted runs).
    const first = { ...base, source: 'mock', externalId: `mock-dedup_${S}`, title: `Senior Data Analyst (Remote) - Req #${S}`, company: `Maple ${S} Analytics Inc.`, location: 'Toronto, ON M5V 2T6', applyUrl: 'https://maple.example/jobs/1', description: 'Requirements\n- 3+ years SQL and Python\n- Tableau\nMust be legally authorized to work in Canada.' };
    const second = { ...base, source: 'adzuna', externalId: `adzuna:dedup_${S}`, title: 'Senior Data Analyst', company: `Maple ${S} Analytics`, location: 'Toronto, Ontario, Canada', applyUrl: 'https://aggregator.example/x', description: `Senior Data Analyst at Maple ${S} Analytics. 3+ years SQL and Python. Tableau. Must be legally authorized to work in Canada.` };
    const a = await pipeline.upsertPosting(mock, first);
    assert.equal(a.isNew, true);
    const b = await pipeline.upsertPosting(adzuna, second);
    assert.equal(b.id, a.id, 'resolved to the same canonical job');
    assert.equal(b.isNew, false);
    assert.equal(b.merged, true);
    const job = await db.job.findUniqueOrThrow({ where: { id: a.id }, include: { provenance: { orderBy: { firstSeenAt: 'asc' } }, snapshots: true } });
    assert.equal(job.provenance.length, 2, 'two provenance records');
    assert.deepEqual(job.provenance.map((p) => p.sourceId).sort(), [adzuna.id, mock.id].sort());
    assert.equal(job.snapshots.length, 2, 'one immutable snapshot per capture');
    assert.equal(job.title, first.title, 'the primary source owns the columns');
    assert.equal(job.applyUrl, first.applyUrl);
    assert.equal(job.provenance.find((p) => p.sourceId === adzuna.id)?.applyUrl, second.applyUrl, 'the second source keeps its own apply link');
    assert.equal(job.normalizedTitle, 'senior data analyst');
    assert.equal(job.postalRegion, 'CA-ON/toronto');
    assert.equal(job.workAuthorization, 'authorization_required');
    assert.deepEqual(JSON.parse(job.requiredSkills), ['python', 'sql', 'tableau']);
    // Re-capture from the second source: seen before → lastSeen moves, nothing else grows.
    const again = await pipeline.upsertPosting(adzuna, second);
    assert.equal(again.id, a.id);
    assert.equal(again.merged, false);
    const after = await db.job.findUniqueOrThrow({ where: { id: a.id }, include: { provenance: true, snapshots: true } });
    assert.equal(after.provenance.length, 2);
    assert.equal(after.snapshots.length, 2);
    // A distinct role at the same employer and place is NOT merged.
    const other = await pipeline.upsertPosting(mock, { ...first, externalId: `mock-dedup-other_${S}`, description: 'Marketing analytics.\nRequirements\n- Google Analytics and Looker' });
    assert.notEqual(other.id, a.id);
    assert.equal(other.isNew, true);
    await db.job.deleteMany({ where: { id: { in: [a.id, other.id] } } });
  });

  it('Stage 06 closure is per source: a job stays open while any source still lists it, and closes only when none does', async () => {
    const mock = await db.jobSource.findUniqueOrThrow({ where: { key: 'mock' } });
    const adzuna = await db.jobSource.findUniqueOrThrow({ where: { key: 'adzuna' } });
    const stale = new Date(Date.now() - 3 * 86_400_000);
    const job = await db.job.create({ data: { source: 'mock', externalId: `mock-multi_${S}`, title: 'Multi', company: 'Co', location: 'Toronto', country: 'CA', description: '', requirements: '[]', skills: '[]', applyUrl: 'https://example.test', postedAt: stale, sourceId: mock.id, lastSeenAt: stale, canonicalHash: `h_multi_${S}` } });
    await db.jobProvenance.create({ data: { jobId: job.id, sourceId: mock.id, externalId: `mock-multi_${S}`, firstSeenAt: stale, lastSeenAt: stale } });
    await db.jobProvenance.create({ data: { jobId: job.id, sourceId: adzuna.id, externalId: `adzuna:multi_${S}`, firstSeenAt: stale, lastSeenAt: new Date() } });
    // The mock says its copy is gone, but the other source saw it within the window.
    let run = await pipeline.runRefresh('mock', { staleAfterMs: 86_400_000 });
    assert.equal(run.status, 'ok');
    let row = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(row.activeState, 'active', 'still listed elsewhere: not closed');
    assert.equal(row.closedAt, null);
    // Now the other source's sighting is stale too (and the mock's row is
    // outside its ask window again): the closure stands.
    await db.jobProvenance.updateMany({ where: { jobId: job.id, sourceId: adzuna.id }, data: { lastSeenAt: stale } });
    await db.jobProvenance.updateMany({ where: { jobId: job.id, sourceId: mock.id }, data: { lastCheckedAt: stale } });
    run = await pipeline.runRefresh('mock', { staleAfterMs: 86_400_000 });
    row = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(row.activeState, 'closed');
    assert.ok(row.closedAt);
    await db.job.delete({ where: { id: job.id } });
  });

  it('Stage 06 review M4/M5: doubt is per source too, and the sweep makes progress instead of re-asking the same rows', async () => {
    const mock = await db.jobSource.findUniqueOrThrow({ where: { key: 'mock' } });
    const adzuna = await db.jobSource.findUniqueOrThrow({ where: { key: 'adzuna' } });
    const stale = new Date(Date.now() - 3 * 86_400_000);
    const job = await db.job.create({ data: { source: 'mock', externalId: `foreign-doubt_${S}`, title: 'Doubt', company: 'Co', location: 'Toronto', country: 'CA', description: '', requirements: '[]', skills: '[]', applyUrl: 'https://example.test', postedAt: stale, sourceId: mock.id, lastSeenAt: stale, canonicalHash: `h_doubt_${S}` } });
    // The mock cannot speak for a foreign id (unknown); the other source saw it today.
    const mine = await db.jobProvenance.create({ data: { jobId: job.id, sourceId: mock.id, externalId: `foreign-doubt_${S}`, firstSeenAt: stale, lastSeenAt: stale } });
    await db.jobProvenance.create({ data: { jobId: job.id, sourceId: adzuna.id, externalId: `adzuna:doubt_${S}`, firstSeenAt: stale, lastSeenAt: new Date() } });
    const first = await pipeline.runRefresh('mock', { staleAfterMs: 86_400_000 });
    assert.equal(first.status, 'ok');
    let row = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(row.activeState, 'active', 'confirmed open by another source today: not unknown');
    const checked = await db.jobProvenance.findUniqueOrThrow({ where: { id: mine.id } });
    assert.ok(checked.lastCheckedAt, 'the sweep records that it asked');
    // A second sweep in the same window does not re-ask about the row it just asked about.
    const before = first.discovered;
    const second = await pipeline.runRefresh('mock', { staleAfterMs: 86_400_000 });
    assert.ok(second.discovered < before || second.discovered === 0, `progress: ${before} → ${second.discovered}`);
    const rechecked = await db.jobProvenance.findUniqueOrThrow({ where: { id: mine.id } });
    assert.equal(rechecked.lastCheckedAt?.getTime(), checked.lastCheckedAt?.getTime(), 'not re-asked within the window');
    // Once the other source's sighting is stale too, the doubt stands.
    await db.jobProvenance.updateMany({ where: { jobId: job.id, sourceId: adzuna.id }, data: { lastSeenAt: stale } });
    await db.jobProvenance.update({ where: { id: mine.id }, data: { lastCheckedAt: stale } });
    await pipeline.runRefresh('mock', { staleAfterMs: 86_400_000 });
    row = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(row.activeState, 'unknown');
    assert.equal(row.closedAt, null, 'never inferred as closed');
    await db.job.delete({ where: { id: job.id } });
  });

  it('Stage 06 review M6/L14: a closed job is never a merge target (a repost is a new job); a job whose register row is gone adopts the next capture as primary', async () => {
    const mock = await db.jobSource.findUniqueOrThrow({ where: { key: 'mock' } });
    const adzuna = await db.jobSource.findUniqueOrThrow({ where: { key: 'adzuna' } });
    const base = { companyLogo: undefined, salaryMin: undefined, salaryMax: undefined, salaryCurrency: 'CAD', nocCode: undefined, applyMethod: 'external' as const, postedAt: '2026-09-01T00:00:00.000Z', requirements: [], skills: ['go', 'kubernetes'], country: 'CA' as const, workMode: 'hybrid' as const, jobType: 'full_time' as const, location: 'Toronto, ON', description: 'Go and Kubernetes.' };
    const first = { ...base, source: 'mock', externalId: `mock-repost_${S}`, title: 'Platform Engineer', company: `Repost ${S} Ltd`, applyUrl: 'https://a.example/1', postedAt: '2025-01-01T00:00:00.000Z' };
    const a = await pipeline.upsertPosting(mock, first);
    await db.job.update({ where: { id: a.id }, data: { activeState: 'closed', closedAt: new Date('2025-03-01') } });
    const again = await pipeline.upsertPosting(adzuna, { ...first, source: 'adzuna', externalId: `adzuna:repost_${S}`, applyUrl: 'https://b.example/2', postedAt: '2026-09-01T00:00:00.000Z' });
    assert.notEqual(again.id, a.id, 'the closed job is not revived by a twin from another source');
    assert.equal(again.isNew, true);
    const dead = await db.job.findUniqueOrThrow({ where: { id: a.id } });
    assert.equal(dead.activeState, 'closed', 'and stays closed');
    // Register row gone: sourceId is null on the job; the next capture becomes the primary and re-keys the row.
    const orphan = await db.job.create({ data: { source: 'gone', externalId: `gone_${S}`, title: 'Platform Engineer', company: `Orphan ${S} Ltd`, location: 'Toronto, ON', country: 'CA', description: 'Old text', requirements: '[]', skills: '[]', applyUrl: 'https://old.example', postedAt: new Date('2026-08-01'), sourceId: null, canonicalHash: 'placeholder' } });
    const capture = { ...first, source: 'mock', externalId: `mock-adopt_${S}`, company: `Orphan ${S} Ltd`, applyUrl: 'https://new.example', postedAt: '2026-09-01T00:00:00.000Z' };
    const { canonicalize } = await import('../src/lib/jobs/canonical');
    await db.job.update({ where: { id: orphan.id }, data: { canonicalHash: canonicalize(capture).canonicalHash } });
    const adopted = await pipeline.upsertPosting(mock, capture);
    assert.equal(adopted.id, orphan.id);
    assert.equal(adopted.merged, true);
    const row = await db.job.findUniqueOrThrow({ where: { id: orphan.id }, include: { provenance: true } });
    assert.equal(row.source, 'mock');
    assert.equal(row.externalId, capture.externalId, 're-keyed to the adopting capture');
    assert.equal(row.applyUrl, 'https://new.example');
    assert.equal(row.description, 'Go and Kubernetes.');
    assert.equal(row.sourceId, mock.id);
    assert.equal(row.provenance.length, 1);
    await db.job.deleteMany({ where: { id: { in: [a.id, again.id, orphan.id] } } });
  });

  it('Stage 06 review H1: the job page reads provenance on the tenant path without the system-only register, and resolves names outside it', async () => {
    const job = await db.job.findFirstOrThrow({ where: { provenance: { some: {} } }, select: { id: true } });
    // The page's include, verbatim, as app_tenant.
    const loaded = await ctx.withTenant({ userId: USER.id }, (tx) => tx.job.findUnique({ where: { id: job.id }, include: { occupation: { include: { labels: true, codes: true } }, provenance: { orderBy: { firstSeenAt: 'asc' } } } }));
    assert.ok(loaded && loaded.provenance.length >= 1);
    // The relation the review found: including the register throws for a tenant.
    await assert.rejects(
      () => ctx.withTenant({ userId: USER.id }, (tx) => tx.job.findUnique({ where: { id: job.id }, include: { provenance: { include: { source: true } } } })),
      /required to return data|Inconsistent query result/,
    );
    const names = await registry.sourceNamesFor(loaded!.provenance.map((p) => p.sourceId));
    for (const p of loaded!.provenance) assert.ok(names.get(p.sourceId), 'every source resolves to a display name');
  });

  it('Stage 06: tenants read provenance and cannot write it', async () => {
    const job = await db.job.findFirstOrThrow({ where: { provenance: { some: {} } }, select: { id: true } });
    const rows = await ctx.withTenant({ userId: USER.id }, (tx) => tx.jobProvenance.findMany({ where: { jobId: job.id } }));
    assert.ok(rows.length >= 1);
    await assert.rejects(
      () => ctx.withTenant({ userId: USER.id }, (tx) => tx.jobProvenance.update({ where: { id: rows[0].id }, data: { applyUrl: 'https://evil.example' } })),
      /row-level security|42501|permission denied|Record to update not found|No record was found/,
    );
  });

  it('health: runs for a disabled source, but never contacts a source whose record is incomplete — even with credentials present — and reports missing credentials by name', async () => {
    // Record incomplete + credentials present: the adapter must NOT be called.
    await db.jobSource.update({ where: { key: 'adzuna' }, data: { status: 'disabled', legalBasis: '', termsReviewedAt: null, termsReviewedByEmail: null, approvedAt: null, approvedByEmail: null } });
    process.env.ADZUNA_APP_ID = 'test-id';
    process.env.ADZUNA_APP_KEY = 'test-key';
    const originalFetch = globalThis.fetch;
    let contacted = 0;
    globalThis.fetch = (async () => { contacted += 1; return new Response('{}', { status: 200 }); }) as typeof fetch;
    try {
      const incomplete = await pipeline.runHealthCheck('adzuna');
      assert.equal(incomplete.report.status, 'down');
      assert.match(incomplete.report.detail, /record incomplete/);
      assert.equal(contacted, 0, 'no request leaves the boundary before a person records the terms');
      const run = await db.jobSourceRun.findFirst({ where: { source: { key: 'adzuna' }, kind: 'health' }, orderBy: { startedAt: 'desc' } });
      assert.match(run?.error ?? '', /record incomplete/);
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.ADZUNA_APP_ID;
      delete process.env.ADZUNA_APP_KEY;
    }
    // Record complete, credentials absent: named, still no contact.
    await db.jobSource.update({ where: { key: 'adzuna' }, data: { legalBasis: 'x', termsReviewedAt: new Date(), termsReviewedByEmail: STAFF.email, approvedAt: new Date(), approvedByEmail: STAFF.email } });
    const adzuna = await pipeline.runHealthCheck('adzuna');
    assert.equal(adzuna.report.status, 'down');
    assert.match(adzuna.report.detail, /missing credential\(s\): ADZUNA_APP_ID, ADZUNA_APP_KEY/);
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
    // A REAL job id, so the only thing that can refuse the insert is the policy.
    const job = await db.job.findFirstOrThrow({ where: { source: 'mock' }, select: { id: true } });
    await assert.rejects(
      () => ctx.withTenant({ userId: USER.id }, (tx) => tx.jobSnapshot.create({ data: { jobId: job.id, sourceHash: `tenant_${S}`, payload: '{}' } })),
      /row-level security|42501|permission denied/,
    );
  });
});
