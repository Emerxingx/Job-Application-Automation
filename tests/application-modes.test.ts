/**
 * Stage 12 — application modes (ADR-0016). Proves the unreachable mode
 * cannot be chosen, that no mode permits an unattended submission, and
 * that the reachable modes permit exactly what they say.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { APPLICATION_MODES, ApplicationModeError, assertModePermits, DEFAULT_APPLICATION_MODE, MODE_PERMITS, modePermits, parseApplicationMode, storedApplicationMode, UNREACHABLE_MODE } from '../src/lib/apply/modes';

describe('application modes', () => {
  it('refuses Approved Auto-Apply wherever a mode is parsed, with the reason', () => {
    assert.throws(() => parseApplicationMode(UNREACHABLE_MODE), (e: unknown) => e instanceof ApplicationModeError && e.status === 403 && /ADR-0016/.test(e.message) && /Stage 22/.test(e.message));
    assert.throws(() => parseApplicationMode('auto'), (e: unknown) => e instanceof ApplicationModeError && e.status === 422);
    assert.throws(() => parseApplicationMode(''), ApplicationModeError);
    for (const m of APPLICATION_MODES) assert.equal(parseApplicationMode(m), m);
  });

  it('a stored value that is not a reachable mode reads back as the default, never as more', () => {
    assert.equal(storedApplicationMode(UNREACHABLE_MODE), DEFAULT_APPLICATION_MODE);
    assert.equal(storedApplicationMode(null), DEFAULT_APPLICATION_MODE);
    assert.equal(storedApplicationMode('recommend_only'), 'recommend_only');
    assert.equal(DEFAULT_APPLICATION_MODE, 'review_submit');
  });

  it('no mode permits an unattended submission; the table says exactly what each permits', () => {
    for (const m of APPLICATION_MODES) assert.equal(modePermits(m, 'submit_unattended'), false, m);
    assert.deepEqual(MODE_PERMITS.recommend_only, { generate_documents: false, prepare_fields: false, submit_on_instruction: false, submit_unattended: false });
    assert.deepEqual(MODE_PERMITS.prepare, { generate_documents: true, prepare_fields: true, submit_on_instruction: false, submit_unattended: false });
    assert.deepEqual(MODE_PERMITS.review_submit, { generate_documents: true, prepare_fields: true, submit_on_instruction: true, submit_unattended: false });
    assert.ok(!(UNREACHABLE_MODE in MODE_PERMITS), 'the unreachable mode has no permission row at all');
  });

  it('refusals are said in the applicant\'s words and name the setting', () => {
    assert.throws(() => assertModePermits('recommend_only', 'generate_documents'), /Recommend only/);
    assert.throws(() => assertModePermits('prepare', 'submit_on_instruction'), /Prepare.*does not submit/);
    assert.throws(() => assertModePermits('review_submit', 'submit_unattended'), /never submits an application without your instruction/);
    assert.doesNotThrow(() => assertModePermits('review_submit', 'submit_on_instruction'));
    assert.doesNotThrow(() => assertModePermits('prepare', 'prepare_fields'));
  });
});
