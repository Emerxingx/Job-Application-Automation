/**
 * Stage 05 — the governed ATS ruleset registry (ADR-0019 Tier 1), moved out
 * of the CMS: validation (no evasion setting), the draft → approved → active
 * lifecycle with separation of duties, one active per platform, rollback
 * recorded as rollback, retirement rules, cache invalidation on activation,
 * and an audit row per change.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { validateRulesetInput, validateSelectorMap, REQUIRED_SELECTOR_KEYS } from '../src/lib/apply/ats-rulesets';

const SELECTORS = Object.fromEntries(REQUIRED_SELECTOR_KEYS.map((k) => [k, `#${k}`]));

describe('ATS rulesets — validation (pure)', () => {
  it('requires every selector key and refuses any evasion setting', () => {
    assert.equal(validateSelectorMap(SELECTORS), null);
    assert.match(validateSelectorMap({ ...SELECTORS, email: '' })!, /missing "email"/);
    assert.match(validateRulesetInput({ platform: 'greenhouse', navigationFlowType: 'single_page', pacing: 'heavy_stealth', selectorMap: SELECTORS })!, /no evasion setting/);
    assert.match(validateRulesetInput({ platform: 'nope', navigationFlowType: 'single_page', pacing: 'standard', selectorMap: SELECTORS })!, /Unknown platform/);
    assert.equal(validateRulesetInput({ platform: 'lever', navigationFlowType: 'multi_step', pacing: 'human_delay', selectorMap: SELECTORS, fallbackSelectors: { email: ['input[type=email]'] } }), null);
  });
});

const CONNECTION_STRING = process.env.TENANCY_TEST_DATABASE_URL;
const REQUIRED = process.env.CI === 'true' || process.env.RLS_TEST_REQUIRED === '1';
if (!CONNECTION_STRING && REQUIRED) throw new Error('TENANCY_TEST_DATABASE_URL is required here (see ci.yml).');
const SKIP = CONNECTION_STRING ? false : 'TENANCY_TEST_DATABASE_URL is not set. REQUIRED in CI.';

type Db = typeof import('../src/lib/db')['db'];
type Reg = typeof import('../src/lib/apply/ats-rulesets');
const S = randomBytes(4).toString('hex');
const A = { id: `ats_a_${S}`, email: `ats-a-${S}@ats.test`, fullName: 'A', role: 'admin' as const, storedRole: 'admin' };
const B = { id: `ats_b_${S}`, email: `ats-b-${S}@ats.test`, fullName: 'B', role: 'admin' as const, storedRole: 'admin' };
// Each run uses a platform nobody else touches in this database.
const PLATFORM = 'taleo';
let db: Db;
let reg: Reg;

describe('ATS rulesets — lifecycle against the database', { skip: SKIP }, () => {
  before(async () => {
    process.env.DATABASE_URL = CONNECTION_STRING;
    ({ db } = await import('../src/lib/db'));
    reg = await import('../src/lib/apply/ats-rulesets');
    await db.atsRuleset.deleteMany({ where: { platform: PLATFORM } });
    await reg.invalidateAtsRuleset(PLATFORM);
  });
  after(async () => {
    await db.atsRuleset.deleteMany({ where: { platform: PLATFORM } });
    await reg.invalidateAtsRuleset(PLATFORM);
    await db.auditLog.deleteMany({ where: { actorId: { in: [A.id, B.id] } } });
    await db.$disconnect();
  });

  const input = (n: number) => ({ platform: PLATFORM, navigationFlowType: 'single_page', pacing: 'standard', selectorMap: { ...SELECTORS, submit_button: `#submit-v${n}` }, notes: `v${n}` });

  it('create → approve (second admin) → activate; the read path serves it; audited', async () => {
    assert.equal(await reg.getActiveAtsRuleset(PLATFORM), null);
    const v1 = await reg.createAtsRuleset(input(1), A);
    assert.equal(v1.version, 1);
    assert.equal(v1.status, 'draft');
    await assert.rejects(() => reg.activateAtsRuleset(v1.id, A), /Only an approved version/);
    await assert.rejects(() => reg.approveAtsRuleset(v1.id, A), /second admin/);
    await reg.approveAtsRuleset(v1.id, B);
    await reg.activateAtsRuleset(v1.id, A, 'go live');
    const active = await reg.getActiveAtsRuleset(PLATFORM);
    assert.equal(active?.version, 1);
    assert.equal(active?.selectorMap.submit_button, '#submit-v1');
    const audit = await db.auditLog.findMany({ where: { entityType: 'AtsRuleset', entityId: v1.id }, orderBy: { createdAt: 'asc' } });
    assert.deepEqual(audit.map((a) => a.action), ['ats_ruleset.create', 'ats_ruleset.approve', 'ats_ruleset.activate']);
    assert.equal(audit[1].actorEmail, B.email);
    assert.equal(JSON.parse(audit[2].after).selectorKeys.length, REQUIRED_SELECTOR_KEYS.length);
  });

  it('activating v2 demotes v1; the cache is invalidated so the engine sees v2 at once; activating v1 again is a rollback', async () => {
    const v2 = await reg.createAtsRuleset(input(2), A);
    await reg.approveAtsRuleset(v2.id, B);
    await reg.activateAtsRuleset(v2.id, A);
    assert.equal((await reg.getActiveAtsRuleset(PLATFORM))?.version, 2);
    const rows = await db.atsRuleset.findMany({ where: { platform: PLATFORM }, orderBy: { version: 'asc' } });
    assert.deepEqual(rows.map((r) => r.status), ['approved', 'active']);
    await reg.activateAtsRuleset(rows[0].id, A, 'v2 broke the form');
    assert.equal((await reg.getActiveAtsRuleset(PLATFORM))?.version, 1);
    const last = await db.auditLog.findFirstOrThrow({ where: { entityType: 'AtsRuleset', entityId: rows[0].id }, orderBy: { createdAt: 'desc' } });
    assert.equal(last.action, 'ats_ruleset.rollback');
    assert.equal(last.reason, 'v2 broke the form');
  });

  it('the active version cannot be retired; a non-active can; a draft with a bad map is refused', async () => {
    const [v1, v2] = await db.atsRuleset.findMany({ where: { platform: PLATFORM }, orderBy: { version: 'asc' } });
    await assert.rejects(() => reg.retireAtsRuleset(v1.id, A), /cannot be retired/);
    await reg.retireAtsRuleset(v2.id, A);
    await assert.rejects(() => reg.approveAtsRuleset(v2.id, B), /Only a draft/);
    await assert.rejects(() => reg.createAtsRuleset({ ...input(3), selectorMap: { first_name: '#x' } }, A), /missing/);
    assert.equal(await db.atsRuleset.count({ where: { platform: PLATFORM, status: 'active' } }), 1);
  });
});
