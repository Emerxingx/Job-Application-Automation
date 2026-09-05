import { db } from '@/lib/db';
import { pruneReferences } from '@/lib/mailbox/service';
import { recordSecurityEvent } from '@/lib/security-audit';
import { dueErasures, executeErasure, retryFilePurge } from './erasure';

/**
 * Stage 23 (ADR-0037) - the platform retention sweep: the rows of
 * `DATA_RETENTION_MATRIX.md` whose expiry is a platform default (not a
 * contract, not a statute, not an event the code already handles) leave on
 * schedule, and the matrix says which. Readiness gate G3 "Retention
 * enforcement: automated" was FAIL; this is the automation, minus the
 * scheduler (none exists: `npm run retention:sweep` is the operator's
 * command, like every other sweep).
 *
 * What it sweeps, matched to the matrix:
 * - Sessions: 30 days after expiry or revocation (the row is the revocation
 *   record until then).
 * - `AiRun`: two years.
 * - `RollupRun`: one year (an operational log; the marts it built persist).
 * - Mailbox and calendar references: 180 days, through the Stage 11 prune
 *   for every account with a connection.
 * - Aggregate marts (`DailyMetric`, `DailyRevenueRollup`, `DailyUsageRollup`,
 *   `CandidateBenchmarkMart`, `OrganizationDailyMart`): three years.
 * - Scheduled erasures whose grace period has passed, and the file purge of
 *   any completed erasure whose object-store step failed.
 *
 * What it deliberately does NOT sweep, by matrix rule: audit rows (never),
 * consent records (evidence), invoices and payments (seven years, statutory,
 * survive erasure), applications and submitted documents (seven years, the
 * person's own record; they leave only with the person), case notes and
 * outcomes (per provider contract; `npm run cases:retention`), employer
 * pipelines and staffing records (three and seven years; contract terms,
 * not yet automated - stated in the matrix as NOT AUTOMATED).
 *
 * Every sweep writes one `retention.swept` audit row with the counts.
 */
export const RETENTION = {
  sessionDays: 30,
  aiRunDays: 365 * 2,
  rollupRunDays: 365,
  mailboxReferenceDays: 180,
  martDays: 365 * 3,
} as const;

export interface RetentionReport {
  sessions: number;
  aiRuns: number;
  rollupRuns: number;
  mailboxReferences: number;
  martRows: number;
  erasures: number;
  filePurgesRetried: number;
  erasureErrors: number;
}

const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000);
const dayKeyOf = (d: Date) => d.toISOString().slice(0, 10);

export async function sweepRetention(now = new Date()): Promise<RetentionReport> {
  const sessions = (await db.session.deleteMany({ where: { OR: [{ expiresAt: { lt: daysAgo(now, RETENTION.sessionDays) } }, { revokedAt: { lt: daysAgo(now, RETENTION.sessionDays) } }] } })).count;
  const aiRuns = (await db.aiRun.deleteMany({ where: { createdAt: { lt: daysAgo(now, RETENTION.aiRunDays) } } })).count;
  const rollupRuns = (await db.rollupRun.deleteMany({ where: { startedAt: { lt: daysAgo(now, RETENTION.rollupRunDays) } } })).count;

  let mailboxReferences = 0;
  const accounts = await db.mailboxConnection.findMany({ distinct: ['userId'], select: { userId: true } });
  for (const a of accounts) mailboxReferences += await pruneReferences(a.userId, now);

  const martCutoff = dayKeyOf(daysAgo(now, RETENTION.martDays));
  let martRows = 0;
  martRows += (await db.dailyMetric.deleteMany({ where: { day: { lt: martCutoff } } })).count;
  martRows += (await db.dailyRevenueRollup.deleteMany({ where: { day: { lt: martCutoff } } })).count;
  martRows += (await db.dailyUsageRollup.deleteMany({ where: { day: { lt: martCutoff } } })).count;
  martRows += (await db.candidateBenchmarkMart.deleteMany({ where: { day: { lt: martCutoff } } })).count;
  martRows += (await db.organizationDailyMart.deleteMany({ where: { day: { lt: martCutoff } } })).count;

  let erasures = 0;
  let erasureErrors = 0;
  for (const userId of await dueErasures(now)) {
    try {
      await executeErasure(userId, { now });
      erasures += 1;
    } catch {
      erasureErrors += 1;
    }
  }
  let filePurgesRetried = 0;
  for (const r of await db.deletionRequest.findMany({ where: { status: 'completed', purgedFolders: false }, select: { userId: true } })) {
    try {
      await retryFilePurge(r.userId);
      filePurgesRetried += 1;
    } catch {
      erasureErrors += 1;
    }
  }

  const report: RetentionReport = { sessions, aiRuns, rollupRuns, mailboxReferences, martRows, erasures, filePurgesRetried, erasureErrors };
  await recordSecurityEvent({ event: 'retention.swept', actor: { type: 'system' }, entityType: 'RetentionSweep', summary: `Retention sweep: ${sessions} sessions, ${aiRuns} AI runs, ${rollupRuns} rollup runs, ${mailboxReferences} mailbox references, ${martRows} mart rows removed; ${erasures} erasure(s) executed.`, detail: { ...report } });
  return report;
}
