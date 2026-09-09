/**
 * Load a learning-graph file under a RECORDED licence (Stage 16, ADR-0031).
 *
 *   npm run taxonomy:load-learning -- <file.json> <dataset-key>
 *
 * The dataset must already be registered and its licence recorded AND
 * approved at /console/taxonomy; the loader refuses otherwise (the Stage 04
 * gate). The file is validated first. Rows another dataset owns are reported
 * as conflicts and left alone; a NOC code the spine does not hold is reported
 * and not loaded. Exit code 1 when the load was refused, 2 on bad arguments.
 * No scheduler runs this; an operator does, with the licence in hand.
 */
import { readFileSync } from 'node:fs';
import { db } from '../../src/lib/db';
import { loadLearningGraph, validateLearningGraph } from '../../src/lib/career/loader';
import { ensureDatasetRegistry } from '../../src/lib/taxonomy/datasets';
import { redactError } from '../../src/lib/log';

async function main() {
  const [file, key] = process.argv.slice(2);
  if (!file || !key) {
    console.error('[learning] usage: npm run taxonomy:load-learning -- <file.json> <dataset-key>');
    process.exit(2);
  }
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  validateLearningGraph(parsed);
  await ensureDatasetRegistry();
  const report = await loadLearningGraph(parsed, key);
  console.log(`[learning] ${key}: ${report.credentials} credentials, ${report.providers} providers, ${report.offerings} offerings, ${report.occupationCredentials} occupation requirements, ${report.occupationSkills} occupation skills, ${report.skillsCreated} new skills`);
  if (report.unmatchedNoc.length) console.warn(`[learning] NOC codes the spine does not hold (NOT loaded): ${report.unmatchedNoc.join(', ')}`);
  if (report.conflicts.length) console.warn(`[learning] rows another dataset owns (left alone): ${report.conflicts.join('; ')}`);
}

main()
  .catch((error) => {
    console.error(`[learning] refused: ${redactError(error).message}`);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
