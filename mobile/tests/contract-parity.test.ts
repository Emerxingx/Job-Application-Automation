/**
 * The app uses ONLY the published contract (MOBILE_ARCHITECTURE.md, the
 * Stage 14 acceptance criterion): every path the client names is in the
 * document, every operation in the document is reachable from the client,
 * the generated types are in sync with the document, and no screen calls
 * fetch on its own.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { API_PREFIX, PATHS } from '../src/api/client';

const ROOT = path.join(__dirname, '..');
const CONTRACT = path.join(ROOT, '..', 'docs', 'api', 'openapi.candidate.v1.json');
const doc = JSON.parse(readFileSync(CONTRACT, 'utf8')) as { servers: { url: string }[]; info: { version: string }; paths: Record<string, Record<string, { operationId: string }>> };

function filesUnder(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full, ext));
    else if (ext.test(entry)) out.push(full);
  }
  return out;
}

describe('contract parity', () => {
  it('every client path is a contract path, and every contract path has a client method', () => {
    const contractPaths = new Set(Object.keys(doc.paths));
    for (const p of Object.values(PATHS)) assert.ok(contractPaths.has(p), `${p} is not in the contract`);
    const clientPaths = new Set<string>(Object.values(PATHS));
    const unused = [...contractPaths].filter((p) => !clientPaths.has(p));
    // The ATS ruleset lookup is for the automation engine, not a phone (ADR-0028 review note); it is the one contract path the app does not call.
    assert.deepEqual(unused, ['/v1/ats-rulesets/{platform}']);
    assert.equal(API_PREFIX, doc.servers[0]?.url);
  });

  it('the generated types match the document (npm run api:types is a no-op)', () => {
    const generated = readFileSync(path.join(ROOT, 'src', 'api', 'schema.d.ts'), 'utf8');
    const fresh = execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'openapi-typescript', 'bin', 'cli.js'), CONTRACT, '--export-type'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(generated.trim(), fresh.trim(), 'src/api/schema.d.ts is stale: run npm run api:types');
    for (const op of Object.values(doc.paths).flatMap((m) => Object.values(m).map((o) => o.operationId))) assert.ok(generated.includes(`${op}:`), `operation ${op} missing from the generated types`);
  });

  it('no screen or module calls fetch or hard-codes a /v1 path outside the client', () => {
    const files = [...filesUnder(path.join(ROOT, 'app'), /\.tsx?$/), ...filesUnder(path.join(ROOT, 'src'), /\.tsx?$/)].filter((f) => !f.endsWith(path.join('src', 'api', 'client.ts')) && !f.endsWith('schema.d.ts'));
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      assert.ok(!/\bfetch\s*\(/.test(text), `${path.relative(ROOT, file)} calls fetch directly`);
      assert.ok(!/['"`]\/v1\//.test(text), `${path.relative(ROOT, file)} hard-codes a /v1 path`);
      assert.ok(!/from ['"]@react-native-async-storage/.test(text), `${path.relative(ROOT, file)} imports AsyncStorage (MOBILE_ARCHITECTURE.md forbids it for the credential)`);
    }
  });

  it('the app does not carry a secret: no key, token or password literal in source', () => {
    const files = [...filesUnder(path.join(ROOT, 'app'), /\.tsx?$/), ...filesUnder(path.join(ROOT, 'src'), /\.tsx?$/)];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      assert.ok(!/jp_(live|test)_[0-9a-f]{8}/.test(text), `${path.relative(ROOT, file)} contains what looks like an API key`);
      assert.ok(!/sk_(live|test)_|whsec_|eyJ[A-Za-z0-9_-]{20,}/.test(text), `${path.relative(ROOT, file)} contains what looks like a secret`);
    }
  });
});
