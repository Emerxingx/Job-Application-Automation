import type { JobSource, JobSourceRun } from '@prisma/client';
import type { JobSearchQuery } from '@/lib/types';
import { Prisma } from '@prisma/client';
import { db } from '../db';
import { postingHash } from './base';
import { CONNECTOR_DEFINITIONS, missingCredentials, recordComplete, requireEnabledSource, SourceAccessError } from './registry';
import type { JobSourceConnector, NormalizedPosting } from './types';

/**
 * The acquisition pipeline (JOB_INTELLIGENCE_ARCHITECTURE "Pipeline"):
 *
 *   discover → normalize → validate → upsert Job (first/last seen, active)
 *            → JobSnapshot when the content changed → JobSourceRun audit
 *
 * and, alongside, freshness: refresh() / detectClosed() keep `lastSeenAt`,
 * `activeState` and `closedAt` honest. Every run — including a refused one —
 * leaves a JobSourceRun row with counts and the QUERY SHAPE (never a
 * candidate identity). Runs on the system client: Job and its snapshots
 * are shared reference data; the source register is system-only.
 */

export interface DiscoveryResult {
  run: JobSourceRun;
  /** Job ids in discovery order, for the caller to score. */
  jobIds: string[];
}

function queryShape(q: JobSearchQuery) {
  return { titles: q.titles.length, keywords: q.keywords?.length ?? 0, locations: q.locations.length, country: q.country ?? null, workMode: q.workMode ?? null, jobType: q.jobType ?? null, limit: q.limit ?? null };
}

async function startRun(source: JobSource, kind: string, meta: Record<string, unknown>) {
  return db.jobSourceRun.create({ data: { sourceId: source.id, kind, meta: JSON.stringify(meta) } });
}

/** Consecutive failed runs after which an enabled source is marked degraded. */
export const DEGRADE_AFTER_FAILURES = 3;

/**
 * Close a run and update the source's health columns. Every status
 * transition is decided by the DATABASE against the row's current state, not
 * against the copy captured when the run started: a source an admin disabled
 * while the run was in flight stays disabled (the pipeline never flips
 * `status` on its own authority), recovery applies only to a row that is
 * still `degraded`, and the failure threshold is evaluated on the incremented
 * count in the same statement. Exported so the transitions can be tested
 * without a connector.
 */
export async function finishRun(run: JobSourceRun, patch: Partial<Pick<JobSourceRun, 'status' | 'discovered' | 'created' | 'updated' | 'closed' | 'rejected' | 'errorCount' | 'error'>>, source: JobSource) {
  const finished = await db.jobSourceRun.update({ where: { id: run.id }, data: { ...patch, finishedAt: new Date() } });
  const ok = finished.status === 'ok';
  const now = new Date();
  if (ok) {
    await db.jobSource.update({ where: { id: source.id }, data: { lastRunAt: now, lastSuccessAt: now, errorCount: 0, lastError: null } });
    await db.jobSource.updateMany({ where: { id: source.id, status: 'degraded' }, data: { status: 'enabled' } });
  } else {
    await db.jobSource.update({ where: { id: source.id }, data: { lastRunAt: now, errorCount: { increment: 1 }, lastError: finished.error?.slice(0, 500) ?? null } });
    await db.jobSource.updateMany({ where: { id: source.id, status: 'enabled', errorCount: { gte: DEGRADE_AFTER_FAILURES } }, data: { status: 'degraded' } });
  }
  return finished;
}

/** A refusal is recorded at most once per source and kind within this window. */
export const REFUSAL_WINDOW_MS = 10 * 60_000;

/**
 * Record a refused run so the register shows WHY nothing came in. Refusals
 * are tenant-driven (every agent scan against a disabled source is one), so
 * they are coalesced: a refusal of the same kind within the window updates
 * the existing row (latest reason, refusal count) rather than growing a
 * system table without bound.
 */
async function refusedRun(key: string, kind: string, error: SourceAccessError): Promise<JobSourceRun | null> {
  const source = await db.jobSource.findUnique({ where: { key } });
  if (!source) return null;
  const recent = await db.jobSourceRun.findFirst({
    where: { sourceId: source.id, kind, status: 'refused', startedAt: { gte: new Date(Date.now() - REFUSAL_WINDOW_MS) } },
    orderBy: { startedAt: 'desc' },
  });
  if (recent) {
    // The row carries the LATEST reason and how many refusals it stands for.
    return db.jobSourceRun.update({ where: { id: recent.id }, data: { error: error.message.slice(0, 500), finishedAt: new Date(), errorCount: { increment: 1 } } });
  }
  return db.jobSourceRun.create({ data: { sourceId: source.id, kind, status: 'refused', finishedAt: new Date(), errorCount: 1, error: error.message.slice(0, 500) } });
}

/** Discover postings for a query through a registered, enabled, credentialed source. */
export async function runDiscovery(key: string, query: JobSearchQuery): Promise<DiscoveryResult> {
  let gate: { source: JobSource; connector: JobSourceConnector };
  try {
    gate = await requireEnabledSource(key);
  } catch (error) {
    if (error instanceof SourceAccessError) await refusedRun(key, 'discover', error);
    throw error;
  }
  const { source, connector } = gate;
  const run = await startRun(source, 'discover', { query: queryShape(query) });
  const jobIds: string[] = [];
  let created = 0;
  let updated = 0;
  let rejected = 0;
  try {
    const discovered = await connector.discover(query);
    const now = new Date();
    for (const raw of discovered) {
      const posting = connector.normalize(raw);
      const validation = connector.validate(posting);
      if (!validation.ok) {
        rejected += 1;
        continue;
      }
      const { id, isNew } = await upsertPosting(source, posting, now);
      if (isNew) created += 1;
      else updated += 1;
      jobIds.push(id);
    }
    await finishRun(run, { status: 'ok', discovered: discovered.length, created, updated, rejected }, source);
  } catch (error) {
    await finishRun(run, { status: 'failed', created, updated, rejected, errorCount: 1, error: error instanceof Error ? error.message : 'discovery failed' }, source);
    throw error;
  }
  const finished = await db.jobSourceRun.findUniqueOrThrow({ where: { id: run.id } });
  return { run: finished, jobIds };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * Upsert one posting. A new posting gets its first snapshot; a known posting
 * has `lastSeenAt` and `activeState` refreshed, and gets a NEW snapshot only
 * when the normalised content changed (the previous snapshot is never
 * touched — the database refuses).
 *
 * Concurrency: two runs of the same source (two users scanning at once) can
 * both see "no row" for a new posting. The loser of that race hits the
 * `(source, externalId)` unique constraint and is treated as an update of
 * the row the winner created, never as a failed run. The job row and its
 * snapshot are written in one transaction so a job can never exist without
 * the snapshot of the content it carries.
 */
export async function upsertPosting(source: JobSource, posting: NormalizedPosting, now = new Date()): Promise<{ id: string; isNew: boolean }> {
  const hash = postingHash(posting);
  const where = { source_externalId: { source: posting.source, externalId: posting.externalId } };
  const columns = {
    title: posting.title,
    company: posting.company,
    companyLogo: posting.companyLogo ?? null,
    location: posting.location,
    country: posting.country,
    workMode: posting.workMode,
    jobType: posting.jobType,
    salaryMin: posting.salaryMin ?? null,
    salaryMax: posting.salaryMax ?? null,
    salaryCurrency: posting.salaryCurrency,
    description: posting.description,
    requirements: JSON.stringify(posting.requirements),
    skills: JSON.stringify(posting.skills),
    nocCode: posting.nocCode ?? null,
    applyUrl: posting.applyUrl,
    applyMethod: posting.applyMethod,
    postedAt: new Date(posting.postedAt),
    scrapedAt: now,
    lastSeenAt: now,
    activeState: 'active',
    closedAt: null,
    sourceId: source.id,
    sourceHash: hash,
  };
  const payload = JSON.stringify(posting);

  let existing = await db.job.findUnique({ where, select: { id: true, sourceHash: true } });
  if (!existing) {
    try {
      return await db.$transaction(async (tx) => {
        const job = await tx.job.create({ data: { source: posting.source, externalId: posting.externalId, firstSeenAt: now, ...columns } });
        await tx.jobSnapshot.create({ data: { jobId: job.id, sourceId: source.id, sourceHash: hash, payload } });
        return { id: job.id, isNew: true };
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Lost the race: another run created it between our read and our write.
      existing = await db.job.findUniqueOrThrow({ where, select: { id: true, sourceHash: true } });
    }
  }
  const id = existing.id;
  if (existing.sourceHash === hash) {
    await db.job.update({ where: { id }, data: { lastSeenAt: now, activeState: 'active', closedAt: null, sourceId: source.id } });
  } else {
    await db.$transaction(async (tx) => {
      await tx.job.update({ where: { id }, data: columns });
      await tx.jobSnapshot.upsert({
        where: { jobId_sourceHash: { jobId: id, sourceHash: hash } },
        create: { jobId: id, sourceId: source.id, sourceHash: hash, payload },
        update: {},
      });
    });
  }
  return { id, isNew: false };
}

/**
 * Freshness pass over a source's active postings not seen for `staleAfterMs`.
 * `closed` closes; `unknown` is recorded as unknown, never inferred as closed.
 */
export async function runRefresh(key: string, options: { staleAfterMs?: number; limit?: number } = {}): Promise<JobSourceRun> {
  let gate: { source: JobSource; connector: JobSourceConnector };
  try {
    gate = await requireEnabledSource(key);
  } catch (error) {
    if (error instanceof SourceAccessError) await refusedRun(key, 'refresh', error);
    throw error;
  }
  const { source, connector } = gate;
  const staleBefore = new Date(Date.now() - (options.staleAfterMs ?? 24 * 3_600_000));
  const run = await startRun(source, 'refresh', { staleBefore: staleBefore.toISOString() });
  try {
    const stale = await db.job.findMany({
      where: { sourceId: source.id, activeState: { in: ['active', 'unknown'] }, lastSeenAt: { lt: staleBefore } },
      select: { id: true, externalId: true },
      orderBy: { lastSeenAt: 'asc' },
      take: Math.min(options.limit ?? 200, 1000),
    });
    const states = stale.length ? await connector.refresh(stale.map((j) => j.externalId)) : {};
    let closed = 0;
    let updated = 0;
    const now = new Date();
    for (const job of stale) {
      const state = states[job.externalId] ?? 'unknown';
      if (state === 'closed') {
        await db.job.update({ where: { id: job.id }, data: { activeState: 'closed', closedAt: now } });
        closed += 1;
      } else if (state === 'active') {
        await db.job.update({ where: { id: job.id }, data: { activeState: 'active', lastSeenAt: now, closedAt: null } });
        updated += 1;
      } else {
        await db.job.update({ where: { id: job.id }, data: { activeState: 'unknown' } });
      }
    }
    return finishRun(run, { status: 'ok', discovered: stale.length, updated, closed }, source);
  } catch (error) {
    return finishRun(run, { status: 'failed', errorCount: 1, error: error instanceof Error ? error.message : 'refresh failed' }, source);
  }
}

/**
 * Health check for one registered source. It runs for a DISABLED source —
 * health is how an operator learns it is safe to enable — but never for one
 * whose per-connector record is incomplete: the first request to a third
 * party is made only after a person has recorded the legal basis, terms
 * review, approval and retention (SOURCE_ACCESS_POLICY.md). Missing
 * credentials are reported by NAME without loading the adapter either.
 */
export async function runHealthCheck(key: string): Promise<{ source: JobSource; report: import('./types').HealthReport }> {
  const source = await db.jobSource.findUnique({ where: { key } });
  if (!source) throw new SourceAccessError('Unknown job source.', 404);
  const definition = CONNECTOR_DEFINITIONS.find((d) => d.key === key);
  if (!definition) throw new SourceAccessError('Unknown job source.', 404);
  let report: import('./types').HealthReport;
  const missing = missingCredentials(source);
  if (!recordComplete(source)) {
    report = { status: 'down', latencyMs: 0, detail: 'per-connector record incomplete: the source is not contacted until a person records its legal basis, terms review, approval and retention (SOURCE_ACCESS_POLICY.md)' };
  } else if (missing.length) {
    report = { status: 'down', latencyMs: 0, detail: `missing credential(s): ${missing.join(', ')}` };
  } else {
    report = await (await definition.load()).healthCheck();
  }
  const run = await startRun(source, 'health', { status: report.status, latencyMs: report.latencyMs });
  await db.jobSourceRun.update({ where: { id: run.id }, data: { status: report.status === 'down' ? 'failed' : 'ok', finishedAt: new Date(), error: report.status === 'down' ? report.detail : null } });
  const updated = await db.jobSource.update({ where: { id: source.id }, data: { lastHealthAt: new Date(), lastHealthStatus: report.status } });
  return { source: updated, report };
}
