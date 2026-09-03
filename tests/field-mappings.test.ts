/**
 * Stage 12 — the governed field-mapping register against the database
 * (ADR-0019 Tier 1): draft → second-admin approval → active with a
 * mandatory reason, rollback recorded as rollback, retirement rules, the
 * built-in fallback when nothing is active, cache invalidation, and an
 * audit row per change.
 */
import './helpers/database-env'; // FIRST: the static imports below reach src/lib/db
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

const CONNECTION_STRING = process.env.TENANCY_TEST_DATABASE_URL;
const REQUIRED = process.env.CI === 'true' || process.env.RLS_TEST_REQUIRED === '1';
if (!CONNECTION_STRING && REQUIRED) throw new Error('TENANCY_TEST_DATABASE_URL is required here (see ci.yml).');
const SKIP = CONNECTION_STRING ? false : 'TENANCY_TEST_DATABASE_URL is not set. REQUIRED in CI.';

type Db = typeof import('../src/lib/db')['db'];
type Reg = typeof import('../src/lib/apply/field-mappings');
const S = randomBytes(4).toString('hex');
const A = { id: `fm_a_${S}`, email: `fm-a-${S}@fm.test`, fullName: 'A', role: 'admin' as const, storedRole: 'admin' };
const B = { id: `fm_b_${S}`, email: `fm-b-${S}@fm.test`, fullName: 'B', role: 'admin' as const, storedRole: 'admin' };
let db: Db;
let reg: Reg;

describe('field mappings — lifecycle against the database', { skip: SKIP }, () => {
  before(async () => {
    process.env.DATABASE_URL = CONNECTION_STRING;
    ({ db } = await import('../src/lib/db'));
    reg = await import('../src/lib/apply/field-mappings');
    await db.fieldMappingVersion.deleteMany({});
    await reg.invalidateActiveFieldMappings();
  });
  after(async () => {
    await db.fieldMappingVersion.deleteMany({});
    await reg.invalidateActiveFieldMappings();
    await db.auditLog.deleteMany({ where: { actorId: { in: [A.id, B.id] } } });
    await db.$disconnect();
  });

  const input = (n: number) => ({ mappings: [...reg.BUILTIN_FIELD_MAPPINGS, { canonicalFieldKey: `custom_${n}`, label: `Custom ${n}`, dataType: 'text' as const, patterns: [{ kind: 'contains' as const, pattern: `custom question ${n}` }], fallbackRule: 'Leave blank if unknown.' }], notes: `v${n}` });

  it('the built-in set applies and is recorded as builtin:1 until a version is active', async () => {
    const active = await reg.getActiveFieldMappings();
    assert.equal(active.version, reg.BUILTIN_FIELD_MAPPING_VERSION);
    assert.equal(active.mappings.length, reg.BUILTIN_FIELD_MAPPINGS.length);
  });

  it('create → approve (second admin) → activate with a reason; the read path serves it; audited', async () => {
    await assert.rejects(() => reg.createFieldMappingVersion({ mappings: [{ canonicalFieldKey: 'x_key', label: 'x', dataType: 'text', patterns: [], fallbackRule: 'y' }] }, A), /at least one pattern/);
    const v1 = await reg.createFieldMappingVersion(input(1), A);
    assert.equal(v1.status, 'draft');
    await assert.rejects(() => reg.approveFieldMappingVersion(v1.id, A), /second admin/);
    await assert.rejects(() => reg.activateFieldMappingVersion(v1.id, B, 'x'), /Only an approved version/);
    const approved = await reg.approveFieldMappingVersion(v1.id, B);
    assert.equal(approved.status, 'approved');
    await assert.rejects(() => reg.activateFieldMappingVersion(v1.id, B), /reason is required/);
    const active = await reg.activateFieldMappingVersion(v1.id, B, 'first governed register');
    assert.equal(active.status, 'active');
    const served = await reg.getActiveFieldMappings();
    assert.equal(served.version, 'v1');
    assert.ok(served.mappings.some((m) => m.canonicalFieldKey === 'custom_1'));
    assert.equal(reg.matchMapping('Custom question 1 please', served.mappings)?.canonicalFieldKey, 'custom_1');
    const actions = (await db.auditLog.findMany({ where: { entityType: 'FieldMappingVersion', entityId: v1.id }, orderBy: { createdAt: 'asc' } })).map((a) => a.action);
    assert.deepEqual(actions, ['field_mappings.create', 'field_mappings.approve', 'field_mappings.activate']);
  });

  it('activating an older approved version is recorded as a rollback; the demoted version stays approved; the cache follows', async () => {
    const v2 = await reg.createFieldMappingVersion(input(2), A);
    await reg.approveFieldMappingVersion(v2.id, B);
    await reg.activateFieldMappingVersion(v2.id, B, 'v2');
    assert.equal((await reg.getActiveFieldMappings()).version, 'v2');
    const v1 = (await reg.listFieldMappingVersions()).find((v) => v.version === 1)!;
    assert.equal(v1.status, 'approved');
    await reg.activateFieldMappingVersion(v1.id, A, 'v2 mis-mapped salary');
    assert.equal((await reg.getActiveFieldMappings()).version, 'v1');
    const rollback = await db.auditLog.findFirst({ where: { entityType: 'FieldMappingVersion', action: 'field_mappings.rollback' } });
    assert.ok(rollback && /from v2 to v1/.test(rollback.summary) && rollback.reason === 'v2 mis-mapped salary');
  });

  it('the active version cannot be retired; a retired one cannot be approved; a draft can be retired', async () => {
    const versions = await reg.listFieldMappingVersions();
    const active = versions.find((v) => v.status === 'active')!;
    await assert.rejects(() => reg.retireFieldMappingVersion(active.id, A), /cannot be retired/);
    const v3 = await reg.createFieldMappingVersion(input(3), A);
    const retired = await reg.retireFieldMappingVersion(v3.id, B, 'not needed');
    assert.equal(retired.status, 'retired');
    await assert.rejects(() => reg.approveFieldMappingVersion(v3.id, B), /Only a draft/);
    await assert.rejects(() => reg.retireFieldMappingVersion(v3.id, B), /already retired/);
  });

  it('a stored row that no longer validates falls back to the built-in set and is not cached', async () => {
    const active = (await reg.listFieldMappingVersions()).find((v) => v.status === 'active')!;
    await db.fieldMappingVersion.update({ where: { id: active.id }, data: { mappings: '[{"canonicalFieldKey":"broken"}]' } });
    await reg.invalidateActiveFieldMappings();
    const served = await reg.getActiveFieldMappings();
    assert.equal(served.version, reg.BUILTIN_FIELD_MAPPING_VERSION);
    await db.fieldMappingVersion.update({ where: { id: active.id }, data: { mappings: JSON.stringify(input(1).mappings) } });
    await reg.invalidateActiveFieldMappings();
    assert.equal((await reg.getActiveFieldMappings()).version, 'v1', 'a corrected row applies at once — nothing was cached');
  });
});
