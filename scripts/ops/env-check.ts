/**
 * Stage 24 (ADR-0038) - `npm run env:check`: is this environment shaped like
 * production? Prints one line per finding - a name, PASS/WARN/FAIL and a
 * sentence - and NEVER a value. Exits 1 on any FAIL. Run it against the
 * production configuration before every deploy (DEPLOYMENT.md §0).
 */
import { checkEnvironment } from '@/lib/ops/env-check';

const report = checkEnvironment(process.env);
const width = Math.max(...report.findings.map((f) => f.name.length));
for (const f of report.findings) console.log(`${f.status.padEnd(4)} ${f.name.padEnd(width)}  ${f.detail}`);
const fails = report.findings.filter((f) => f.status === 'FAIL').length;
const warns = report.findings.filter((f) => f.status === 'WARN').length;
console.log(`\n[env:check] ${report.findings.length} checks: ${fails} FAIL, ${warns} WARN. No secret and no connection string was printed.`);
process.exit(report.ok ? 0 : 1);
