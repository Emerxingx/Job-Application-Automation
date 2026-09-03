import type { Job, Prisma } from '@prisma/client';
import { db } from '../db';
import { occupationFamily } from '@/lib/jobs/canonical';
import { inferNocCode } from './fallback';

/**
 * Title → canonical occupation, with the METHOD recorded (ADR-0009: "the
 * Adzuna regex table is superseded by real classification but retained as a
 * low-confidence fallback, with confidence recorded rather than implied").
 *
 *   title_exact      — the normalised title equals a UNIT GROUP's normalised
 *                      title in some locale (high)
 *   title_alternate  — it equals one of the unit group's normalised example
 *                      titles (high)
 *   regex_fallback   — the legacy regex table matched and an occupation
 *                      carries that NOC code (low)
 *   none             — nothing matched; the posting stays unclassified rather
 *                      than being guessed
 *
 * Both sides are normalised the same way (`normalizeTitle`, stored on the
 * label at load time), so punctuation-heavy real titles —
 * "Développeurs/développeuses et programmeurs/programmeuses Web",
 * "Business, finance and administration occupations" — meet a posting on
 * one form. A posting title is tried whole, then as its head before the
 * first qualifier separator (" - ", " | ", ": ", ", "), so "Business
 * Analyst, Payments" reaches the "Business analyst" example. Only unit
 * groups can match by title: a posting is never classified to a category.
 *
 * The canonical occupation is jurisdiction-neutral; the caller reads the
 * code for its jurisdiction from `OccupationCode` (see `queries.crosswalk`).
 */

export type ClassificationMethod = 'title_exact' | 'title_alternate' | 'regex_fallback' | 'none';

export interface Classification {
  occupationId: string | null;
  method: ClassificationMethod;
  confidence: 'high' | 'low' | 'none';
  /** The NOC 2021 code, when the occupation carries one. */
  nocCode: string | null;
}

type Client = Prisma.TransactionClient | typeof db;

const LEADING_QUALIFIER = /^(?:(?:senior|junior|lead|principal|staff|intermediate|associate|chief|head|sr|jr)\s+)+/;
const TRAILING_QUALIFIER = /(?:\s+(?:i|ii|iii|iv|v|senior|junior|sr|jr|intern|co-op|coop))+$/;

/**
 * One normal form for titles on both sides: lower-case; bracketed text
 * removed; every non-letter/digit (hyphens, slashes, apostrophes, commas)
 * becomes a space, so "Full-Stack" and "Full Stack" and "d'information" and
 * "d information" agree; seniority qualifiers stripped only at the start
 * ("Senior …", "Lead …", "Chief …") and the end ("… II", "… Senior") — never
 * from the middle, so "Chief of Staff" keeps "of staff" and "Lead Hand" keeps
 * "hand" only when "lead" was leading. Accented letters are kept as they are.
 */
export function normalizeTitle(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const stripped = base.replace(LEADING_QUALIFIER, '').replace(TRAILING_QUALIFIER, '').trim();
  return stripped || base;
}

/** The whole title, then its head before the first qualifier separator. */
export function titleCandidates(title: string): string[] {
  const whole = normalizeTitle(title);
  const head = normalizeTitle(title.replace(/\(.*?\)|\[.*?\]/g, ' ').split(/\s+[-–—|]\s+|\s*[:,|]\s+|\s+[-–—]\s*$/)[0] ?? title);
  return whole === head || !head ? [whole].filter(Boolean) : [whole, head];
}

const NONE: Classification = { occupationId: null, method: 'none', confidence: 'none', nocCode: null };

export async function classifyTitle(title: string, client: Client = db): Promise<Classification> {
  const candidates = titleCandidates(title);
  if (candidates.length === 0) return NONE;

  for (const norm of candidates) {
    // Exact normalised title on a unit group, any locale.
    const exact = await client.occupationLabel.findMany({
      where: { normalizedTitle: norm, occupation: { level: 'unit' } },
      select: { occupationId: true },
      orderBy: { occupationId: 'asc' },
      take: 5,
    });
    const exactIds = [...new Set(exact.map((l) => l.occupationId))];
    if (exactIds.length === 1) return withCode(client, exactIds[0], 'title_exact');
    if (exactIds.length > 1) return NONE; // ambiguous: never guess between two occupations

    // Example titles: a bounded, ordered prefilter on the normalised JSON
    // (the quoted form cannot match across an entry boundary), then an
    // exact comparison in code.
    const alt = await client.occupationLabel.findMany({
      where: { normalizedAlternates: { contains: `"${norm}"` }, occupation: { level: 'unit' } },
      select: { occupationId: true, normalizedAlternates: true },
      orderBy: { occupationId: 'asc' },
      take: 20,
    });
    const altIds = [
      ...new Set(
        alt
          .filter((l) => {
            try {
              return (JSON.parse(l.normalizedAlternates) as string[]).includes(norm);
            } catch {
              return false;
            }
          })
          .map((l) => l.occupationId),
      ),
    ];
    if (altIds.length === 1) return withCode(client, altIds[0], 'title_alternate');
    if (altIds.length > 1) return NONE;
  }

  const noc = inferNocCode(title);
  if (noc) {
    const code = await client.occupationCode.findFirst({
      where: { scheme: 'NOC2021', code: noc },
      select: { occupationId: true },
      orderBy: { version: 'desc' },
    });
    if (code) return { occupationId: code.occupationId, method: 'regex_fallback', confidence: 'low', nocCode: noc };
  }
  return NONE;
}

async function withCode(client: Client, occupationId: string, method: 'title_exact' | 'title_alternate'): Promise<Classification> {
  const code = await client.occupationCode.findFirst({ where: { occupationId, scheme: 'NOC2021' }, select: { code: true }, orderBy: { version: 'desc' } });
  return { occupationId, method, confidence: 'high', nocCode: code?.code ?? null };
}

/**
 * Classify a stored posting once and record the method. A high-confidence
 * result OVERWRITES a capture-time `nocCode` (the adapters' regex guess);
 * a low-confidence or empty result leaves it and is recorded as such, so
 * the page can qualify it. Short-circuits when no dataset has been loaded:
 * with an empty spine there is nothing to classify against.
 */
export async function classifyStoredJob(job: Pick<Job, 'id' | 'title' | 'occupationId' | 'nocCode'>, client: typeof db = db): Promise<Classification | null> {
  if (job.occupationId) return null;
  // "Loaded" means unit groups exist — a recorded crosswalk dataset with
  // nothing to attach to is not a spine.
  const loaded = await client.occupation.count({ where: { level: 'unit' } });
  if (loaded === 0) return null;
  const classified = await classifyTitle(job.title, client);
  const nocCode = classified.confidence === 'high' ? (classified.nocCode ?? job.nocCode) : (job.nocCode ?? classified.nocCode);
  // Stage 06: the canonical job carries the SOC code alongside the NOC code
  // (through the occupation's own codes, i.e. the loaded crosswalk) and the
  // NOC broad category as its occupation family. Both are null until known.
  const soc = classified.occupationId
    ? await client.occupationCode.findFirst({ where: { occupationId: classified.occupationId, scheme: { startsWith: 'SOC' } }, select: { code: true } })
    : null;
  await client.job.update({
    where: { id: job.id },
    data: {
      occupationId: classified.occupationId,
      occupationSource: classified.method,
      nocCode,
      socCode: soc?.code ?? null,
      occupationFamily: occupationFamily(nocCode),
    },
  });
  return classified;
}
