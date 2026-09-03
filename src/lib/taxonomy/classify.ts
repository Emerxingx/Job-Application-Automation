import type { Prisma } from '@prisma/client';
import { db } from '../db';
import { inferNocCode } from './fallback';

/**
 * Title → canonical occupation, with the METHOD recorded (ADR-0009: "the
 * Adzuna regex table is superseded by real classification but retained as a
 * low-confidence fallback, with confidence recorded rather than implied").
 *
 *   title_exact      — the normalised title equals an occupation's title in
 *                      some locale (high)
 *   title_alternate  — it equals one of the occupation's example titles (high)
 *   regex_fallback   — the legacy regex table matched, and an occupation
 *                      carries that NOC code (low)
 *   none             — nothing matched; the posting stays unclassified rather
 *                      than being guessed
 *
 * Classification is jurisdiction-aware in the sense that matters here: the
 * canonical occupation is jurisdiction-neutral, and the caller reads the
 * code for its jurisdiction from `OccupationCode` (see `codesFor`).
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

/** Lower-case, collapse whitespace and punctuation, strip seniority/level qualifiers and bracketed tails. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    // Brackets and everything after a separator (dash, pipe, colon, comma):
    // "Business Analyst, Payments" and "Data Analyst - Remote" are the role, then a qualifier.
    .replace(/\(.*?\)|\[.*?\]|\s*[-–—|:,].*$/g, ' ')
    .replace(/\b(senior|junior|lead|principal|staff|intermediate|associate|sr\.?|jr\.?|ii|iii|iv)\b/g, ' ')
    .replace(/[^a-z0-9àâçéèêëîïôûùüÿœ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NONE: Classification = { occupationId: null, method: 'none', confidence: 'none', nocCode: null };

export async function classifyTitle(title: string, client: Client = db): Promise<Classification> {
  const norm = normalizeTitle(title);
  if (!norm) return NONE;

  // Exact title in any locale — a case-insensitive equality on the normalised form.
  const candidates = await client.occupationLabel.findMany({
    where: { title: { equals: norm, mode: 'insensitive' } },
    select: { occupationId: true },
    take: 2,
  });
  if (candidates.length === 1) return withCode(client, candidates[0].occupationId, 'title_exact');

  // Alternate titles: stored as a JSON array; a bounded scan over the unit
  // groups whose alternates contain the phrase, then exact comparison in code.
  const alt = await client.occupationLabel.findMany({
    where: { alternateTitles: { contains: norm, mode: 'insensitive' } },
    select: { occupationId: true, alternateTitles: true },
    take: 20,
  });
  const exactAlt = alt.filter((l) => {
    try {
      return (JSON.parse(l.alternateTitles) as string[]).some((t) => normalizeTitle(t) === norm);
    } catch {
      return false;
    }
  });
  const distinct = [...new Set(exactAlt.map((l) => l.occupationId))];
  if (distinct.length === 1) return withCode(client, distinct[0], 'title_alternate');

  const noc = inferNocCode(title);
  if (noc) {
    const code = await client.occupationCode.findFirst({ where: { scheme: 'NOC2021', code: noc }, select: { occupationId: true } });
    if (code) return { occupationId: code.occupationId, method: 'regex_fallback', confidence: 'low', nocCode: noc };
  }
  return NONE;
}

async function withCode(client: Client, occupationId: string, method: 'title_exact' | 'title_alternate'): Promise<Classification> {
  const code = await client.occupationCode.findFirst({ where: { occupationId, scheme: 'NOC2021' }, select: { code: true } });
  return { occupationId, method, confidence: 'high', nocCode: code?.code ?? null };
}
