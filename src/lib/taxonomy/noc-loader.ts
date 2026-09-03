import type { Prisma } from '@prisma/client';
import { db } from '../db';
import { requireIngestible } from './datasets';

/**
 * Loader for the NOC 2021 structure file (Statistics Canada publishes the
 * classification as a CSV with one row per node of the hierarchy: Level,
 * Hierarchical structure, Code, Class title, Class definition). The parser
 * is written against that documented shape and exercised on a hand-written
 * fixture; the real file is loaded only once the dataset's licence is
 * recorded (`requireIngestible`).
 *
 * What it builds: one canonical Occupation per node, parented by code
 * prefix (NOC's codes are hierarchical: 2 → 21 → 212 → 2122 → 21223 —
 * `teer` rows are the 2-digit second-level nodes labelled "TEER"), an
 * OccupationCode row (scheme NOC2021, the dataset's version, TEER carried
 * explicitly from the code's second digit for unit groups), and a label per
 * locale supplied. Idempotent on (scheme, version, code).
 */

export interface NocRow {
  level: number; // 1..5
  code: string;
  title: string;
  definition?: string;
  locale: 'en' | 'fr';
  /** Example titles for the node (unit groups), when the source provides them. */
  alternateTitles?: string[];
}

const LEVEL_NAME: Record<number, string> = { 1: 'broad', 2: 'teer', 3: 'major', 4: 'sub_major', 5: 'unit' };

/** Parse the CSV text. Quoted fields with embedded commas and newlines are handled. */
export function parseNocCsv(text: string, locale: 'en' | 'fr' = 'en'): NocRow[] {
  const records = csv(text);
  if (records.length === 0) return [];
  const header = records[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.findIndex((h) => h.startsWith(name));
  const iLevel = col('level');
  const iCode = col('code');
  const iTitle = col('class title');
  const iDef = col('class definition');
  const iAlt = col('example');
  if (iLevel < 0 || iCode < 0 || iTitle < 0) throw new Error('Unrecognised NOC file: expected Level, Code and Class title columns.');
  const rows: NocRow[] = [];
  for (const r of records.slice(1)) {
    const level = Number(r[iLevel]);
    const code = (r[iCode] ?? '').trim();
    const title = (r[iTitle] ?? '').trim();
    if (!Number.isInteger(level) || level < 1 || level > 5 || !code || !title) continue;
    if (!/^\d{1,5}$/.test(code)) continue;
    rows.push({
      level,
      code,
      title,
      definition: iDef >= 0 ? (r[iDef] ?? '').trim() : '',
      locale,
      alternateTitles: iAlt >= 0 && r[iAlt] ? r[iAlt].split(/;|\n/).map((t) => t.trim()).filter(Boolean) : [],
    });
  }
  return rows;
}

function csv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((f) => f.trim() !== '')) out.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) out.push(row);
  return out;
}

/** NOC codes nest by prefix: the parent of "21223" is "2122", of "2" is nothing. */
export function nocParentCode(code: string): string | null {
  return code.length > 1 ? code.slice(0, -1) : null;
}

/** TEER is the second digit of a NOC 2021 code, defined for level ≥ 2. */
export function nocTeer(code: string): number | null {
  return code.length >= 2 ? Number(code[1]) : null;
}

export interface LoadReport {
  datasetKey: string;
  occupations: number;
  labels: number;
  codes: number;
}

type Client = Prisma.TransactionClient | typeof db;

/**
 * Load parsed rows under a dataset. Refuses unless the dataset is ingestible.
 * Runs on the system client (reference tables have no tenant write policy).
 */
export async function loadNocRows(rows: NocRow[], datasetKey: string, client: Client = db): Promise<LoadReport> {
  const dataset = await requireIngestible(client, datasetKey);
  const report: LoadReport = { datasetKey, occupations: 0, labels: 0, codes: 0 };
  // Parents before children: level order.
  const ordered = [...rows].sort((a, b) => a.level - b.level || a.code.localeCompare(b.code));
  const idByCode = new Map<string, string>();
  for (const row of ordered) {
    const slug = `noc2021-${row.code}`;
    const parentCode = nocParentCode(row.code);
    let parentId = parentCode ? idByCode.get(parentCode) : undefined;
    if (parentCode && !parentId) {
      const parent = await client.occupation.findUnique({ where: { slug: `noc2021-${parentCode}` }, select: { id: true } });
      parentId = parent?.id;
    }
    let occupation = await client.occupation.findUnique({ where: { slug } });
    if (!occupation) {
      occupation = await client.occupation.create({ data: { slug, level: LEVEL_NAME[row.level], parentId: parentId ?? null, datasetId: dataset.id } });
      report.occupations += 1;
    } else if (parentId && occupation.parentId !== parentId) {
      occupation = await client.occupation.update({ where: { id: occupation.id }, data: { parentId } });
    }
    idByCode.set(row.code, occupation.id);

    const existingCode = await client.occupationCode.findFirst({ where: { scheme: 'NOC2021', version: dataset.version, code: row.code, occupationId: occupation.id } });
    if (!existingCode) {
      await client.occupationCode.create({ data: { occupationId: occupation.id, scheme: 'NOC2021', version: dataset.version, code: row.code, teer: nocTeer(row.code) } });
      report.codes += 1;
    }
    const label = await client.occupationLabel.upsert({
      where: { occupationId_locale: { occupationId: occupation.id, locale: row.locale } },
      create: { occupationId: occupation.id, locale: row.locale, title: row.title, description: row.definition ?? '', alternateTitles: JSON.stringify(row.alternateTitles ?? []) },
      update: { title: row.title, description: row.definition ?? '', alternateTitles: JSON.stringify(row.alternateTitles ?? []) },
      select: { createdAt: true, updatedAt: true },
    });
    if (label.createdAt.getTime() === label.updatedAt.getTime()) report.labels += 1;
  }
  const rowCount = await client.occupationCode.count({ where: { scheme: 'NOC2021', version: dataset.version } });
  await client.taxonomyDataset.update({ where: { id: dataset.id }, data: { ingestedAt: new Date(), rowCount } });
  return report;
}

/**
 * Attach SOC 2018 codes to existing canonical occupations — the NOC↔SOC
 * crosswalk. Each entry names a NOC unit group and the SOC detailed
 * occupation(s) it corresponds to. Refuses unless the SOC dataset is
 * ingestible. Idempotent.
 */
export async function loadSocCrosswalk(entries: { noc: string; soc: string; title?: { en?: string } }[], datasetKey: string, client: Client = db): Promise<{ linked: number; unmatched: string[] }> {
  const dataset = await requireIngestible(client, datasetKey);
  let linked = 0;
  const unmatched: string[] = [];
  for (const e of entries) {
    if (!/^\d{2}-\d{4}$/.test(e.soc)) throw new Error(`Malformed SOC code "${e.soc}" (expected XX-XXXX).`);
    const occupation = await client.occupation.findUnique({ where: { slug: `noc2021-${e.noc}` }, select: { id: true } });
    if (!occupation) {
      unmatched.push(e.noc);
      continue;
    }
    const existing = await client.occupationCode.findFirst({ where: { scheme: 'SOC2018', version: dataset.version, code: e.soc, occupationId: occupation.id } });
    if (!existing) {
      await client.occupationCode.create({ data: { occupationId: occupation.id, scheme: 'SOC2018', version: dataset.version, code: e.soc, isPrimary: true } });
      linked += 1;
    }
  }
  const rowCount = await client.occupationCode.count({ where: { scheme: 'SOC2018', version: dataset.version } });
  await client.taxonomyDataset.update({ where: { id: dataset.id }, data: { ingestedAt: new Date(), rowCount } });
  return { linked, unmatched };
}
