/**
 * Stage 23 (ADR-0037) - throughput of the Stage 21 organisation rollup and
 * the warehouse extraction at a stated volume: `npm run perf:rollup`.
 *
 * Stage 21 recorded "throughput at production volume NOT VERIFIED". This
 * script gives it a number: it creates one synthetic employer organisation
 * with PERF_SUBMISSIONS submissions (default 20 000) spread over 90 days,
 * three stage events each, runs `rollupOrganizations` for that organisation
 * over the window, then `exportMarts` for the mart over the same window
 * into an in-memory sink, prints the timings and rows per second, and
 * deletes everything it created. It runs against whatever DATABASE_URL
 * names - a LOCAL database in the evidence; the managed database has not
 * been measured (network and pooler are not in the loop), and the evidence
 * says so.
 *
 *   PERF_SUBMISSIONS=20000 npm run perf:rollup
 */
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { db } from '@/lib/db';
import { rollupOrganizations } from '@/lib/analytics/organization/rollup';
import { exportMarts } from '@/lib/analytics/warehouse/export';

const N = Math.max(100, Number.parseInt(process.env.PERF_SUBMISSIONS ?? '20000', 10) || 20000);
const S = randomBytes(3).toString('hex');
const DAY = 86_400_000;

async function main() {
  // Stage 23 review (L8): a measurement seeds and deletes rows; never on production.
  if (process.env.NODE_ENV === 'production') throw new Error('perf:rollup seeds and deletes rows and never runs against a production database.');
  const startedAt = new Date();
  const end = new Date(Date.UTC(2025, 0, 1));
  const start = new Date(end.getTime() - 90 * DAY);
  const owner = await db.user.create({ data: { id: `perf_u_${S}`, email: `perf-${S}@perf.invalid`, passwordHash: '!perf:no-password-verifies', fullName: 'Perf', country: 'CA' } });
  const org = await db.organization.create({ data: { id: `perf_org_${S}`, name: 'Perf Employer', slug: `perf-${S}`, type: 'employer', billingEmail: owner.email, memberships: { create: [{ userId: owner.id, role: 'owner', acceptedAt: start }] } } });
  const req = await db.requisition.create({ data: { organizationId: org.id, title: 'Perf', location: 'Vancouver, BC', createdById: owner.id, status: 'open' } });
  console.log(`[perf] seeding ${N} submissions with 3 events each into one organisation (90 days)`);
  const t0 = performance.now();
  const BATCH = 1000;
  for (let i = 0; i < N; i += BATCH) {
    const subs = Array.from({ length: Math.min(BATCH, N - i) }, (_, j) => {
      const k = i + j;
      const createdAt = new Date(start.getTime() + (k % 90) * DAY + 36_000_000);
      return { id: `perf_s_${S}_${k}`, organizationId: org.id, requisitionId: req.id, candidateUserId: `perf_c_${S}_${k}`, source: k % 3 === 0 ? 'applied' : 'sourced', stage: 'screening', createdById: owner.id, createdAt };
    });
    await db.submission.createMany({ data: subs });
    await db.submissionEvent.createMany({
      data: subs.flatMap((s) => [
        { submissionId: s.id, organizationId: org.id, fromStage: 'sourced', toStage: 'consented', actorId: s.candidateUserId, at: new Date(s.createdAt.getTime() + 3_600_000) },
        { submissionId: s.id, organizationId: org.id, fromStage: 'consented', toStage: 'screening', actorId: owner.id, at: new Date(s.createdAt.getTime() + 2 * DAY) },
        { submissionId: s.id, organizationId: org.id, fromStage: 'screening', toStage: 'interviewing', actorId: owner.id, at: new Date(s.createdAt.getTime() + 5 * DAY) },
      ]),
    });
  }
  const seedMs = performance.now() - t0;
  console.log(`[perf] seeded in ${(seedMs / 1000).toFixed(1)}s`);

  const t1 = performance.now();
  const result = await rollupOrganizations({ start, end }, { organizationId: org.id });
  const rollupMs = performance.now() - t1;
  console.log(`[perf] rollupOrganizations: ${result.rowsRead} rows read, ${result.rowsWritten} mart rows written in ${(rollupMs / 1000).toFixed(2)}s (${Math.round(result.rowsRead / (rollupMs / 1000))} source rows/s)`);

  const t2 = performance.now();
  let bytes = 0;
  const exported = await exportMarts({ start, end }, { marts: ['OrganizationDailyMart'], put: async (_key, body) => { bytes += Buffer.byteLength(body); }, exists: async () => false });
  const exportMs = performance.now() - t2;
  const rows = exported.files.reduce((n, f) => n + f.rows, 0);
  console.log(`[perf] exportMarts: ${exported.files.length} files, ${rows} rows, ${(bytes / 1024).toFixed(0)} KiB in ${(exportMs / 1000).toFixed(2)}s (${Math.round(rows / (exportMs / 1000))} rows/s)`);

  if (process.env.PERF_JSON) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(process.env.PERF_JSON, JSON.stringify({ submissions: N, events: N * 3, seedMs, rollup: { ...result, ms: rollupMs }, export: { files: exported.files.length, rows, bytes, ms: exportMs }, measuredAt: new Date().toISOString(), scope: 'local database only' }, null, 2));
  }

  await db.organization.delete({ where: { id: org.id } });
  await db.user.delete({ where: { id: owner.id } });
  // Only the runs this measurement created (by start time), never an operator's history for the same window.
  await db.rollupRun.deleteMany({ where: { job: { startsWith: 'organization_reporting' }, windowStart: start, windowEnd: end, startedAt: { gte: startedAt } } });
  await db.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await db.organization.deleteMany({ where: { id: `perf_org_${S}` } }).catch(() => undefined);
  await db.user.deleteMany({ where: { id: `perf_u_${S}` } }).catch(() => undefined);
  process.exit(1);
});
