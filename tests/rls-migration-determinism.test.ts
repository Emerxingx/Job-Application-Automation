import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';

/**
 * The committed row-level-security migration must be exactly what the
 * generator renders from src/lib/tenancy/rls-tables.ts. If the classification
 * changes without the migration being regenerated — or the migration is edited
 * by hand — the two disagree and this fails. Same posture as the CI
 * generated-file determinism job (ADR-0014).
 */
import { RLS_MANIFESTS, RLS_TABLES } from '../src/lib/tenancy/rls-tables';

describe('RLS migrations are generated, not hand-edited', () => {
  const migrations = path.resolve(__dirname, '../prisma/migrations');

  for (const manifest of RLS_MANIFESTS) {
    it(`${manifest.migration} matches its manifest byte for byte`, () => {
      assert.ok(readdirSync(migrations).includes(manifest.migration), `${manifest.migration} must exist`);
      const committed = readFileSync(path.join(migrations, manifest.migration, 'migration.sql'), 'utf8');
      const rendered = execFileSync(
        process.execPath,
        ['--import', 'tsx', path.resolve(__dirname, '../scripts/rls/generate-migration.ts'), '--manifest', manifest.migration],
        { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' },
      );
      assert.equal(committed, rendered, `regenerate with: npx tsx scripts/rls/generate-migration.ts --manifest ${manifest.migration} > prisma/migrations/${manifest.migration}/migration.sql`);
    });
  }

  it('every classified table is owned by exactly one manifest, and only the first carries the preamble', () => {
    const owned = new Map<string, string>();
    for (const m of RLS_MANIFESTS) {
      for (const t of m.tables) {
        assert.ok(!owned.has(t), `${t} is listed in both ${owned.get(t)} and ${m.migration}`);
        owned.set(t, m.migration);
      }
    }
    const missing = Object.keys(RLS_TABLES).filter((t) => !owned.has(t));
    assert.deepEqual(missing, [], 'a classified table with no manifest has no policies');
    const stray = [...owned.keys()].filter((t) => !(t in RLS_TABLES));
    assert.deepEqual(stray, [], 'a manifest names a table that is not classified');
    assert.deepEqual(RLS_MANIFESTS.map((m) => m.preamble), [true, ...RLS_MANIFESTS.slice(1).map(() => false)]);
  });
});
