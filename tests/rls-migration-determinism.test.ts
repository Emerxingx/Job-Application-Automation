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
describe('RLS migration is generated, not hand-edited', () => {
  it('matches the generator output byte for byte', () => {
    const migrations = path.resolve(__dirname, '../prisma/migrations');
    const dir = readdirSync(migrations).find((d) => d.endsWith('_row_level_security'));
    assert.ok(dir, 'the row_level_security migration must exist');
    const committed = readFileSync(path.join(migrations, dir, 'migration.sql'), 'utf8');
    const rendered = execFileSync(process.execPath, ['--import', 'tsx', path.resolve(__dirname, '../scripts/rls/generate-migration.ts')], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
    });
    assert.equal(committed, rendered, 'regenerate with: npx tsx scripts/rls/generate-migration.ts > prisma/migrations/<dir>/migration.sql');
  });
});
