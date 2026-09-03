import type { JobSource, JobSourceRun } from '@prisma/client';
import type { JobSearchQuery } from '@/lib/types';
import { db } from '../db';
import { postingHash } from './base';
import { requireEnabledSource, SourceAccessError } from './registry';
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

async function finishRun(run: JobSourceRun, patch: Partial<Pick<JobSourceRun, 'status' | 'discovered' | 'created' | 'updated' | 'closed' | 'rejected' | 'errorCount' | 'error'>>, source: JobSource) {
  const finished = await db.jobSourceRun.update({ where: { id: run.id }, data: { ...patch, finishedAt: new Date() } });
  const ok = finished.status === 'ok';
  await db.jobSource.update({
    where: { id: source.id },
    data: {
      lastRunAt: new Date(),
      ...(ok ? { lastSuccessAt: new Date(), errorCount: 0, lastError: null } : { errorCount: { increment: 1 }, lastError: finished.error?.slice(0, 500) ?? null }),
      ...(ok && source.status === 'degraded' ? { status: 'enabled' } : {}),
      ...(!ok && source.status === 'enabled' && source.errorCount + 1 >= 3 ? { status: 'degraded' } : {}),
    },
  });
  return finished;
}

/** Record a refused run so the register shows WHY nothing came in. */
async function refusedRun(key: string, kind: string, error: SourceAccessError): Promise<JobSourceRun | null> {
  const source = await db.jobSource.findUnique({ where: { key } });
  if (!source) return null;
  return db.jobSourceRun.create({ data: { sourceId: source.id, kind, status: 'refused', finishedAt: new Date(), error: error.message.slice(0, 500) } });
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

/**
 * Upsert one posting. A new posting gets its first snapshot; a known posting
 * has `lastSeenAt` and `activeState` refreshed, and gets a NEW snapshot only
 * when the normalised content changed (the previous snapshot is never
 * touched — the database refuses).
 */
export async function upsertPosting(source: JobSource, posting: NormalizedPosting, now = new Date()): Promise<{ id: string; isNew: boolean }> {
  const hash = postingHash(posting);
  const existing = await db.job.findUnique({ where: { source_externalId: { source: posting.source, externalId: posting.externalId } }, select: { id: true, sourceHash: true } });
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
  if (!existing) {
    const job = await db.job.create({ data: { source: posting.source, externalId: posting.externalId, firstSeenAt: now, ...columns } });
    await db.jobSnapshot.create({ data: { jobId: job.id, sourceId: source.id, sourceHash: hash, payload: JSON.stringify(posting) } });
    return { id: job.id, isNew: true };
  }
  if (existing.sourceHash === hash) {
    await db.job.update({ where: { id: existing.id }, data: { lastSeenAt: now, activeState: 'active', closedAt: null, sourceId: source.id } });
  } else {
    await db.job.update({ where: { id: existing.id }, data: columns });
    await db.jobSnapshot.upsert({
      where: { jobId_sourceHash: { jobId: existing.id, sourceHash: hash } },
      create: { jobId: existing.id, sourceId: source.id, sourceHash: hash, payload: JSON.stringify(posting) },
      update: {},
    });
  }
  return { id: existing.id, isNew: false };
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

/** Health check for one registered source (enabled or not: health is how an operator learns it is safe to enable). */
export async function runHealthCheck(key: string): Promise<{ source: JobSource; report: import('./types').HealthReport }> {
  const source = await db.jobSource.findUnique({ where: { key } });
  if (!source) throw new SourceAccessError('Unknown job source.', 404);
  const definition = (await import('./registry')).CONNECTOR_DEFINITIONS.find((d) => d.key === key);
  if (!definition) throw new SourceAccessError('Unknown job source.', 404);
  let report: import('./types').HealthReport;
  const missing = (await import('./registry')).missingCredentials(source);
  if (missing.length) {
    report = { status: 'down', latencyMs: 0, detail: `missing credential(s): ${missing.join(', ')}` };
  } else {
    report = await (await definition.load()).healthCheck();
  }
  const run = await startRun(source, 'health', { status: report.status, latencyMs: report.latencyMs });
  await db.jobSourceRun.update({ where: { id: run.id }, data: { status: report.status === 'down' ? 'failed' : 'ok', finishedAt: new Date(), error: report.status === 'down' ? report.detail : null } });
  const updated = await db.jobSource.update({ where: { id: source.id }, data: { lastHealthAt: new Date(), lastHealthStatus: report.status } });
  return { source: updated, report };
}
