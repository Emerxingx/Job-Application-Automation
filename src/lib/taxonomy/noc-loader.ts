import { db } from '../db';
import { requireIngestible } from './datasets';
import { normalizeTitle } from './classify';

/**
 * Loaders for the NOC 2021 files Statistics Canada publishes.
 *
 * TWO FILES, TWO SHAPES. The STRUCTURE file has one row per node of the
 * hierarchy: Level · Hierarchical structure · Code · Class title · Class
 * definition (EN), or Niveau · Structure hiérarchique · Code · Titre de la
 * classe · Définition de la classe (FR). It carries NO example titles. The
 * ELEMENTS file has one row per element of a unit group: Level · Hierarchical
 * structure · Code · Class title · Element type · Element description — and
 * the rows whose element type is an illustrative example are where the
 * alternate titles come from. Both parsers accept the EN and FR headers, a
 * UTF-8 byte-order mark, CRLF, and quoted fields with embedded commas and
 * newlines. The headers below are the published column names; the fixture
 * files carry them verbatim. **The real files have not been loaded** (L-2),
 * so "written against the published shape" is a claim about the headers and
 * the row structure, not an observed run.
 *
 * What the structure loader builds: one canonical Occupation per node,
 * parented by code prefix (2 → 21 → 212 → 2122 → 21223; the 2-digit level is
 * the TEER category), an OccupationCode row (scheme NOC2021, the dataset's
 * version, TEER carried explicitly from the second digit), and a label per
 * locale with its normalised form for the classifier. A node whose parent is
 * neither in the batch nor already loaded is REFUSED: a unit-groups-only
 * export must not produce five hundred silent roots. Each load runs in one
 * transaction, so a failure leaves nothing half-loaded. Idempotent on
 * (scheme, version, code).
 */

export interface NocRow {
  level: number; // 1..5
  code: string;
  title: string;
  definition?: string;
  locale: 'en' | 'fr';
  /** Example titles for the node, merged in from the elements file when supplied. */
  alternateTitles?: string[];
}

const LEVEL_NAME: Record<number, string> = { 1: 'broad', 2: 'teer', 3: 'major', 4: 'sub_major', 5: 'unit' };

/** Header aliases, EN and FR, matched by prefix after lower-casing. */
const HEADERS = {
  level: ['level', 'niveau'],
  code: ['code'],
  title: ['class title', 'titre de la classe'],
  definition: ['class definition', 'définition de la classe', 'definition de la classe'],
  elementType: ['element type', "type d'élément", 'type d’élément', "type d'element"],
  elementDescription: ['element description', "description de l'élément", 'description de l’élément', "description de l'element"],
  examples: ['example titles', 'exemples'],
} as const;

function findColumn(header: string[], names: readonly string[]): number {
  return header.findIndex((h) => names.some((n) => h.startsWith(n)));
}

function headerOf(records: string[][]): string[] {
  return (records[0] ?? []).map((h, i) => (i === 0 ? h.replace(/^﻿/, '') : h).trim().toLowerCase());
}

/** Parse the STRUCTURE file. */
export function parseNocCsv(text: string, locale: 'en' | 'fr' = 'en'): NocRow[] {
  const records = csv(text);
  if (records.length === 0) return [];
  const header = headerOf(records);
  const iLevel = findColumn(header, HEADERS.level);
  const iCode = findColumn(header, HEADERS.code);
  const iTitle = findColumn(header, HEADERS.title);
  const iDef = findColumn(header, HEADERS.definition);
  const iExamples = findColumn(header, HEADERS.examples);
  if (iLevel < 0 || iCode < 0 || iTitle < 0) {
    throw new Error('Unrecognised NOC structure file: expected Level/Niveau, Code and Class title/Titre de la classe columns.');
  }
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
      alternateTitles: iExamples >= 0 && r[iExamples] ? splitExamples(r[iExamples]) : [],
    });
  }
  return rows;
}

function splitExamples(value: string): string[] {
  return value
    .split(/;|\n/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Parse the ELEMENTS file and return the illustrative examples per code.
 * Element types are matched on "example" / "exemple" so both languages'
 * labels ("Illustrative example(s)", "Exemple(s) illustratif(s)") qualify.
 */
export function parseNocElementsCsv(text: string): Map<string, string[]> {
  const records = csv(text);
  const out = new Map<string, string[]>();
  if (records.length === 0) return out;
  const header = headerOf(records);
  const iCode = findColumn(header, HEADERS.code);
  const iType = findColumn(header, HEADERS.elementType);
  const iDesc = findColumn(header, HEADERS.elementDescription);
  if (iCode < 0 || iType < 0 || iDesc < 0) {
    throw new Error('Unrecognised NOC elements file: expected Code, Element type and Element description columns.');
  }
  for (const r of records.slice(1)) {
    const code = (r[iCode] ?? '').trim();
    const type = (r[iType] ?? '').toLowerCase();
    const desc = (r[iDesc] ?? '').trim();
    if (!/^\d{1,5}$/.test(code) || !desc || !/exampl|exempl/.test(type)) continue;
    const list = out.get(code) ?? [];
    for (const t of splitExamples(desc)) if (!list.includes(t)) list.push(t);
    out.set(code, list);
  }
  return out;
}

/** Attach example titles from the elements file to parsed structure rows. */
export function withExamples(rows: NocRow[], examples: Map<string, string[]>): NocRow[] {
  return rows.map((r) => (examples.has(r.code) ? { ...r, alternateTitles: [...new Set([...(r.alternateTitles ?? []), ...examples.get(r.code)!])] } : r));
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

/**
 * Load parsed rows under a dataset. Refuses unless the dataset is ingestible;
 * refuses a node whose parent is missing; runs in one transaction. Runs on
 * the system client (reference tables have no tenant write policy).
 */
export async function loadNocRows(rows: NocRow[], datasetKey: string, client: typeof db = db): Promise<LoadReport> {
  await requireIngestible(client, datasetKey);
  return client.$transaction(
    async (tx) => {
      const dataset = await requireIngestible(tx, datasetKey);
      const report: LoadReport = { datasetKey, occupations: 0, labels: 0, codes: 0 };
      const ordered = [...rows].sort((a, b) => a.level - b.level || a.code.localeCompare(b.code));
      const batchCodes = new Set(rows.map((r) => r.code));
      const idByCode = new Map<string, string>();
      for (const row of ordered) {
        const slug = `noc2021-${row.code}`;
        const parentCode = nocParentCode(row.code);
        let parentId: string | undefined;
        if (parentCode) {
          parentId = idByCode.get(parentCode);
          if (!parentId) {
            const parent = await tx.occupation.findUnique({ where: { slug: `noc2021-${parentCode}` }, select: { id: true } });
            parentId = parent?.id;
          }
          if (!parentId) {
            throw new Error(
              `NOC ${row.code} has no parent ${parentCode}${batchCodes.has(parentCode) ? '' : ' in this file or the database'}: load the full structure file, not an extract.`,
            );
          }
        }
        let occupation = await tx.occupation.findUnique({ where: { slug } });
        if (!occupation) {
          occupation = await tx.occupation.create({ data: { slug, level: LEVEL_NAME[row.level], parentId: parentId ?? null, datasetId: dataset.id } });
          report.occupations += 1;
        } else if (parentId && occupation.parentId !== parentId) {
          occupation = await tx.occupation.update({ where: { id: occupation.id }, data: { parentId } });
        }
        idByCode.set(row.code, occupation.id);

        const existingCode = await tx.occupationCode.findFirst({ where: { scheme: 'NOC2021', version: dataset.version, code: row.code, occupationId: occupation.id } });
        if (!existingCode) {
          await tx.occupationCode.create({ data: { occupationId: occupation.id, scheme: 'NOC2021', version: dataset.version, code: row.code, teer: nocTeer(row.code) } });
          report.codes += 1;
        }
        const alternates = row.alternateTitles ?? [];
        const labelData = {
          title: row.title,
          normalizedTitle: normalizeTitle(row.title),
          description: row.definition ?? '',
          alternateTitles: JSON.stringify(alternates),
          normalizedAlternates: JSON.stringify(alternates.map((t) => normalizeTitle(t))),
        };
        const existingLabel = await tx.occupationLabel.findUnique({ where: { occupationId_locale: { occupationId: occupation.id, locale: row.locale } }, select: { id: true } });
        if (existingLabel) await tx.occupationLabel.update({ where: { id: existingLabel.id }, data: labelData });
        else {
          await tx.occupationLabel.create({ data: { occupationId: occupation.id, locale: row.locale, ...labelData } });
          report.labels += 1;
        }
      }
      const rowCount = await tx.occupationCode.count({ where: { scheme: 'NOC2021', version: dataset.version } });
      await tx.taxonomyDataset.update({ where: { id: dataset.id }, data: { ingestedAt: new Date(), rowCount } });
      return report;
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
}

/**
 * Attach SOC 2018 codes to existing canonical occupations — the NOC↔SOC
 * crosswalk. Each entry names a NOC unit group and the SOC detailed
 * occupation it corresponds to. Refuses unless the SOC dataset is
 * ingestible; one transaction; idempotent.
 */
export async function loadSocCrosswalk(entries: { noc: string; soc: string }[], datasetKey: string, client: typeof db = db): Promise<{ linked: number; unmatched: string[] }> {
  await requireIngestible(client, datasetKey);
  return client.$transaction(
    async (tx) => {
      const dataset = await requireIngestible(tx, datasetKey);
      let linked = 0;
      const unmatched: string[] = [];
      for (const e of entries) {
        if (!/^\d{2}-\d{4}$/.test(e.soc)) throw new Error(`Malformed SOC code "${e.soc}" (expected XX-XXXX).`);
        const occupation = await tx.occupation.findUnique({ where: { slug: `noc2021-${e.noc}` }, select: { id: true } });
        if (!occupation) {
          unmatched.push(e.noc);
          continue;
        }
        const existing = await tx.occupationCode.findFirst({ where: { scheme: 'SOC2018', version: dataset.version, code: e.soc, occupationId: occupation.id } });
        if (!existing) {
          await tx.occupationCode.create({ data: { occupationId: occupation.id, scheme: 'SOC2018', version: dataset.version, code: e.soc, isPrimary: true } });
          linked += 1;
        }
      }
      const rowCount = await tx.occupationCode.count({ where: { scheme: 'SOC2018', version: dataset.version } });
      await tx.taxonomyDataset.update({ where: { id: dataset.id }, data: { ingestedAt: new Date(), rowCount } });
      return { linked, unmatched };
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
}
