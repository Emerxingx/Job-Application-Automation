import type { Prisma } from '@prisma/client';
import { db } from '../db';

/**
 * Read-side helpers for the occupational spine. All run on whichever client
 * is passed — the tenant transaction is fine, since every table read here is
 * `reference` (SELECT for every tenant, no writes). Nothing here joins the
 * dataset register: it is system-only, so a tenant-path query that touched
 * it would see nothing. What keeps these reads honest is the gate itself —
 * a withdrawn or prohibited dataset is PURGED and a load is one transaction,
 * so the rows that exist are the rows that may be served.
 */

type Client = Prisma.TransactionClient | typeof db;

export interface OccupationView {
  id: string;
  slug: string;
  level: string;
  parentId: string | null;
  labels: { locale: string; title: string; description: string; alternateTitles: string[] }[];
  codes: { scheme: string; version: string; code: string; teer: number | null }[];
}

function toView(o: {
  id: string;
  slug: string;
  level: string;
  parentId: string | null;
  labels: { locale: string; title: string; description: string; alternateTitles: string }[];
  codes: { scheme: string; version: string; code: string; teer: number | null }[];
}): OccupationView {
  return {
    id: o.id,
    slug: o.slug,
    level: o.level,
    parentId: o.parentId,
    labels: o.labels.map((l) => {
      let alternateTitles: string[] = [];
      try {
        alternateTitles = JSON.parse(l.alternateTitles) as string[];
      } catch {
        /* malformed source rows show no alternates rather than failing the page */
      }
      return { locale: l.locale, title: l.title, description: l.description, alternateTitles };
    }),
    codes: o.codes.map((c) => ({ scheme: c.scheme, version: c.version, code: c.code, teer: c.teer })),
  };
}

const INCLUDE = { labels: true, codes: true } satisfies Prisma.OccupationInclude;

/** The hierarchy, most specific first — string order on `level` is meaningless. */
const LEVEL_RANK: Record<string, number> = { unit: 0, minor: 1, sub_major: 2, major: 3, teer: 4, broad: 5 };

export async function getOccupation(client: Client, id: string): Promise<OccupationView | null> {
  const o = await client.occupation.findUnique({ where: { id }, include: INCLUDE });
  return o ? toView(o) : null;
}

/** Search by title (any locale), alternate title, or code. Unit groups first. */
export async function searchOccupations(client: Client, query: string, options: { locale?: string; limit?: number } = {}): Promise<OccupationView[]> {
  const q = query.trim();
  if (!q) return [];
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
  const locale = options.locale ? { locale: options.locale } : {};
  const rows = await client.occupation.findMany({
    where: {
      OR: [
        { labels: { some: { title: { contains: q, mode: 'insensitive' }, ...locale } } },
        { labels: { some: { alternateTitles: { contains: q, mode: 'insensitive' }, ...locale } } },
        { codes: { some: { code: { startsWith: q } } } },
      ],
    },
    include: INCLUDE,
    orderBy: { slug: 'asc' },
    take: limit,
  });
  return rows.map(toView).sort((a, b) => (LEVEL_RANK[a.level] ?? 9) - (LEVEL_RANK[b.level] ?? 9) || a.slug.localeCompare(b.slug));
}

/** Translate a code between schemes through the canonical occupation. */
export async function crosswalk(client: Client, from: { scheme: string; code: string }, toScheme: string): Promise<string[]> {
  const rows = await client.occupationCode.findMany({ where: { scheme: from.scheme, code: from.code }, select: { occupationId: true } });
  if (rows.length === 0) return [];
  const targets = await client.occupationCode.findMany({
    where: { scheme: toScheme, occupationId: { in: rows.map((r) => r.occupationId) } },
    select: { code: true },
    distinct: ['code'],
  });
  return targets.map((t) => t.code).sort();
}

export interface CompletenessReport {
  occupations: number;
  byLevel: Record<string, number>;
  codesByScheme: Record<string, number>;
  /** Occupations missing a label in the given locale. */
  missingLabels: Record<string, string[]>;
  /** Unit groups with no SOC code — the crosswalk gap. */
  unitGroupsWithoutSoc: string[];
  /**
   * Nodes below the top of the tree with no parent — a unit-groups-only
   * extract would produce hundreds. (A dangling parentId is impossible: the
   * foreign key SET NULLs it, which lands the node here.)
   */
  orphans: string[];
}

/** The integrity and bilingual-completeness report the tests and the console read. */
export async function completeness(client: Client, locales: string[] = ['en', 'fr']): Promise<CompletenessReport> {
  const all = await client.occupation.findMany({ include: { labels: { select: { locale: true } }, codes: { select: { scheme: true } } } });
  const byLevel: Record<string, number> = {};
  const codesByScheme: Record<string, number> = {};
  const missingLabels: Record<string, string[]> = Object.fromEntries(locales.map((l) => [l, []]));
  const unitGroupsWithoutSoc: string[] = [];
  const orphans: string[] = [];
  for (const o of all) {
    byLevel[o.level] = (byLevel[o.level] ?? 0) + 1;
    for (const c of o.codes) codesByScheme[c.scheme] = (codesByScheme[c.scheme] ?? 0) + 1;
    const have = new Set(o.labels.map((l) => l.locale));
    for (const l of locales) if (!have.has(l)) missingLabels[l].push(o.slug);
    if (o.level === 'unit' && !o.codes.some((c) => c.scheme === 'SOC2018')) unitGroupsWithoutSoc.push(o.slug);
    if (!o.parentId && o.level !== 'broad') orphans.push(o.slug);
  }
  return { occupations: all.length, byLevel, codesByScheme, missingLabels, unitGroupsWithoutSoc: unitGroupsWithoutSoc.sort(), orphans: orphans.sort() };
}
