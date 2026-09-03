/**
 * Stage 11 — the leakage proof, in two parts.
 *
 *   1. Static: nothing under src/lib/mailbox imports the AI gateway, a model
 *      provider, or the provider SDK — mailbox content has no path to a
 *      model call, consented or not, because no code exists to make one.
 *   2. Runtime: the gateway's RESTRICTED-field check refuses any payload that
 *      carries a `mailbox` key, so even a future caller that serialised
 *      mailbox content into a task payload would be refused before dispatch.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { assertNoRestrictedFields, RestrictedPayloadError } from '../src/lib/ai/restricted-fields';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

describe('mailbox — no path from mailbox content to a model', () => {
  it('nothing under src/lib/mailbox imports the AI gateway, grounding, a model provider or the SDK', () => {
    const root = path.join(__dirname, '..', 'src', 'lib', 'mailbox');
    const forbidden = [/from ['"](@\/lib\/ai|\.\.\/ai)/, /from ['"](@\/lib\/providers\/ai|\.\.\/providers\/ai)/, /@anthropic-ai\/sdk/, /getExternalModelProvider|getDeterministicEngine/];
    const offenders: string[] = [];
    for (const file of walk(root)) {
      const source = readFileSync(file, 'utf8');
      for (const pattern of forbidden) if (pattern.test(source)) offenders.push(`${path.relative(root, file)}: ${pattern}`);
    }
    assert.deepEqual(offenders, []);
  });
  it('the gateway refuses a payload carrying mailbox content under its RESTRICTED key, wherever it is nested', () => {
    assert.throws(() => assertNoRestrictedFields({ resume: {}, mailbox: { subject: 'Offer letter' } }), RestrictedPayloadError);
    assert.throws(() => assertNoRestrictedFields({ context: [{ thread: { mailbox: 'body text' } }] }), RestrictedPayloadError);
    assert.doesNotThrow(() => assertNoRestrictedFields({ resume: {}, job: { title: 'Analyst' } }));
  });
});
