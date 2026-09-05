/**
 * Stage 24 (ADR-0038) - `npm run smoke -- <origin>`: the production smoke
 * suite against a DEPLOYED origin (DEPLOYMENT.md §0 step 6, ROLLBACK.md).
 * Anonymous, credential-free; exits 1 when any check fails. `SMOKE_JSON`
 * writes the checks to a file for the deploy record.
 */
import { runSmoke } from '@/lib/ops/smoke';

async function main() {
  const origin = process.argv[2] ?? process.env.SMOKE_BASE_URL;
  if (!origin) {
    console.error('usage: npm run smoke -- https://<origin>   (or SMOKE_BASE_URL)');
    process.exit(2);
  }
  const checks = await runSmoke(origin);
  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name.padEnd(width)}  ${c.detail}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n[smoke] ${checks.length} checks against ${origin}: ${failed} failed`);
  if (process.env.SMOKE_JSON) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(process.env.SMOKE_JSON, JSON.stringify({ origin, checkedAt: new Date().toISOString(), checks }, null, 2));
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`[smoke] ${error instanceof Error ? error.message : 'failed'}`);
  process.exit(1);
});
