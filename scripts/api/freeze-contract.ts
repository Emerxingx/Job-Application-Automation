/**
 * Stage 14 - freeze the candidate API contract: write the SHA-256 of the
 * canonical spec into docs/api/openapi.candidate.v1.lock. A contract test
 * fails when the spec and the lock disagree, so a change to the published
 * contract is always a deliberate act with a diff in review - and, per
 * ADR-0028, a breaking change is a new major version, never an edit.
 *
 *   npm run api:freeze
 */
import { writeFileSync } from 'node:fs';
import { CONTRACT_LOCK_PATH, contractHash, contractProblems, loadContract } from '@/lib/integrations/contract';

const doc = loadContract();
const problems = contractProblems(doc);
if (problems.length > 0) {
  console.error('[api] the contract has structural problems; not freezing:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
const line = `${doc.info.version} ${contractHash(doc)}\n`;
writeFileSync(CONTRACT_LOCK_PATH, line);
console.log(`[api] frozen ${doc.info.title} ${line.trim()}`);
