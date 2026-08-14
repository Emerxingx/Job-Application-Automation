#!/usr/bin/env node
/**
 * Runs a Payload CLI command (generate:types, generate:importmap).
 *
 * Why this wrapper exists: Payload's CLI loads `src/payload.config.ts` through
 * a CommonJS `require`, and `@payloadcms/richtext-lexical` is an ESM module
 * with top-level await — which `require` cannot evaluate. The CLI therefore
 * only works when the project is treated as ESM.
 *
 * The application itself builds and runs perfectly well as CommonJS (verified:
 * `next build` compiles clean, 76 tests pass), and converting the whole project
 * to ESM purely to satisfy a codegen tool would mean rewriting the lazy
 * `require()` provider loads in src/lib/providers — real runtime code churn for
 * a build-time convenience.
 *
 * So instead this flips `"type": "module"` on for the duration of the CLI call
 * and restores package.json afterwards, including on failure or Ctrl-C.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = path.join(root, 'package.json');

const original = readFileSync(pkgPath, 'utf8');
let restored = false;

function restore() {
  if (restored) return;
  restored = true;
  writeFileSync(pkgPath, original);
}

// Restore even if the process is interrupted, so a Ctrl-C can never leave the
// project stuck in ESM mode.
process.on('exit', restore);
process.on('SIGINT', () => {
  restore();
  process.exit(130);
});
process.on('SIGTERM', () => {
  restore();
  process.exit(143);
});

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node scripts/payload-cli.mjs <payload-command> [...args]');
  process.exit(1);
}

const pkg = JSON.parse(original);
if (pkg.type === 'module') {
  // Already ESM — nothing to toggle, just run it.
  const direct = spawnSync('npx', ['payload', ...args], { cwd: root, stdio: 'inherit' });
  process.exit(direct.status ?? 1);
}

// Insert "type" after "private" so the restored diff stays readable if a
// crash ever prevents cleanup.
const withType = {};
for (const [key, value] of Object.entries(pkg)) {
  withType[key] = value;
  if (key === 'private') withType.type = 'module';
}
if (!('type' in withType)) withType.type = 'module';

writeFileSync(pkgPath, `${JSON.stringify(withType, null, 2)}\n`);

const result = spawnSync('npx', ['payload', ...args], { cwd: root, stdio: 'inherit' });

restore();
process.exit(result.status ?? 1);
