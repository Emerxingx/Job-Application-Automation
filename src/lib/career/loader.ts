/**
 * Stage 16 (ADR-0031) - loading a learning graph dataset: credentials,
 * providers, offerings, the skills they state they teach, and which
 * occupations require which credentials. Licensed content: the loader
 * refuses unless the dataset's licence is recorded and ingestion approved
 * (`requireIngestible`, the Stage 04 gate), and every row it writes carries
 * the dataset id so a prohibition can purge it.
 *
 * Skills are matched to the shared `Skill` table by normalised name and
 * created when absent; occupations are resolved by NOC 2021 code through
 * `OccupationCode` - a code the taxonomy does not hold is reported, never
 * invented.
 */
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { normalizeSkill } from '@/lib/candidate/profile';
import { requireIngestible } from '@/lib/taxonomy/datasets';

type Client = Prisma.TransactionClient | typeof db;

export interface LearningGraphFile {
  credentials: {
    slug: string;
    name: string;
    kind: string;
    issuer: string;
    issuerUrl?: string;
    jurisdiction?: string;
    recognition?: string;
    regulated?: boolean;
    validityMonths?: number | null;
    renewal?: string;
    spellings?: string[];
    skills?: string[];
  }[];
  providers: { slug: string; name: string; kind: string; country?: string; region?: string; url?: string }[];
  offerings: {
    slug: string;
    provider: string;
    credential?: string | null;
    title: string;
    deliveryMode?: string;
    durationHours?: number | null;
    durationWeeks?: number | null;
    costCents?: number | null;
    currency?: string;
    prerequisites?: string;
    jurisdiction?: string;
    url?: string;
    skills?: string[];
  }[];
  occupationCredentials: { noc: string; credential: string; requirement: string; jurisdiction?: string; note?: string }[];
  /** Skills an occupation asks for, per this dataset (the Stage 04 OaSIS loader is not built; a licensed learning dataset may state them). */
  occupationSkills?: { noc: string; skill: string; importance?: number | null; level?: string | null }[];
}

export interface LearningLoadReport {
  datasetKey: string;
  credentials: number;
  providers: number;
  offerings: number;
  skillsCreated: number;
  occupationCredentials: number;
  occupationSkills: number;
  /** NOC codes the taxonomy does not hold; their requirements were NOT loaded. */
  unmatchedNoc: string[];
  /**
   * Rows another dataset owns (same slug, or the same occupation+skill pair)
   * that this file also carries; they were NOT overwritten or re-parented,
   * so a later prohibition purges exactly what each licence loaded
   * (review finding M3).
   */
  conflicts: string[];
}

const CREDENTIAL_KINDS = new Set(['certification', 'licence', 'degree', 'diploma', 'microcredential', 'badge']);
const RECOGNITION = new Set(['regulated', 'industry', 'vendor', 'unverified']);
const REQUIREMENTS = new Set(['required', 'preferred', 'regulated']);
const DELIVERY = new Set(['online', 'in_person', 'hybrid']);

export function validateLearningGraph(file: unknown): asserts file is LearningGraphFile {
  const f = file as Partial<LearningGraphFile>;
  if (!f || !Array.isArray(f.credentials) || !Array.isArray(f.providers) || !Array.isArray(f.offerings) || !Array.isArray(f.occupationCredentials)) throw new Error('A learning graph file has credentials, providers, offerings and occupationCredentials arrays.');
  const slugs = new Set<string>();
  for (const c of f.credentials) {
    if (!c.slug || !c.name || !c.issuer) throw new Error(`credential ${c.slug ?? '?'}: slug, name and issuer are required`);
    if (!CREDENTIAL_KINDS.has(c.kind)) throw new Error(`credential ${c.slug}: unknown kind ${c.kind}`);
    if (c.recognition && !RECOGNITION.has(c.recognition)) throw new Error(`credential ${c.slug}: unknown recognition ${c.recognition}`);
    if (slugs.has(c.slug)) throw new Error(`credential ${c.slug}: duplicate slug`);
    slugs.add(c.slug);
  }
  const providers = new Set(f.providers.map((p) => p.slug));
  for (const o of f.offerings) {
    if (!o.slug || !o.title || !providers.has(o.provider)) throw new Error(`offering ${o.slug ?? '?'}: slug, title and a known provider are required`);
    if (o.credential && !slugs.has(o.credential)) throw new Error(`offering ${o.slug}: unknown credential ${o.credential}`);
    if (o.deliveryMode && !DELIVERY.has(o.deliveryMode)) throw new Error(`offering ${o.slug}: unknown deliveryMode ${o.deliveryMode}`);
  }
  for (const r of f.occupationSkills ?? []) {
    if (!/^\d{5}$/.test(r.noc) || !r.skill) throw new Error(`occupationSkill: ${r.noc} needs a NOC 2021 unit-group code and a skill`);
    if (r.importance !== undefined && r.importance !== null && (!Number.isInteger(r.importance) || r.importance < 1 || r.importance > 5)) throw new Error(`occupationSkill ${r.noc}/${r.skill}: importance is 1..5`);
  }
  for (const r of f.occupationCredentials) {
    if (!/^\d{5}$/.test(r.noc)) throw new Error(`occupationCredential: ${r.noc} is not a NOC 2021 unit-group code`);
    if (!slugs.has(r.credential)) throw new Error(`occupationCredential ${r.noc}: unknown credential ${r.credential}`);
    if (!REQUIREMENTS.has(r.requirement)) throw new Error(`occupationCredential ${r.noc}: unknown requirement ${r.requirement}`);
  }
}

async function ensureSkill(client: Client, name: string, created: { n: number }): Promise<string> {
  const normalizedName = normalizeSkill(name);
  const existing = await client.skill.findUnique({ where: { normalizedName }, select: { id: true } });
  if (existing) return existing.id;
  const row = await client.skill.create({ data: { name: name.trim(), normalizedName } });
  created.n += 1;
  return row.id;
}

/** Load (upsert) a validated file under a licensed dataset. Idempotent by slug. */
export async function loadLearningGraph(file: LearningGraphFile, datasetKey: string, client: Client = db): Promise<LearningLoadReport> {
  validateLearningGraph(file);
  const dataset = await requireIngestible(client, datasetKey);
  const created = { n: 0 };
  const conflicts: string[] = [];
  const owned = (kind: string, slug: string, existing: { datasetId: string | null } | null): boolean => {
    if (existing && existing.datasetId !== null && existing.datasetId !== dataset.id) {
      conflicts.push(`${kind}:${slug}`);
      return false;
    }
    return true;
  };
  const credentialIds = new Map<string, string>();
  for (const c of file.credentials) {
    if (!owned('credential', c.slug, await client.credential.findUnique({ where: { slug: c.slug }, select: { datasetId: true } }))) continue;
    const row = await client.credential.upsert({
      where: { slug: c.slug },
      create: { slug: c.slug, name: c.name, kind: c.kind, issuer: c.issuer, issuerUrl: c.issuerUrl ?? '', jurisdiction: c.jurisdiction ?? 'CA', recognition: c.recognition ?? 'unverified', regulated: c.regulated ?? false, validityMonths: c.validityMonths ?? null, renewal: c.renewal ?? '', spellings: JSON.stringify((c.spellings ?? []).map((s) => s.toLowerCase())), datasetId: dataset.id },
      update: { name: c.name, kind: c.kind, issuer: c.issuer, issuerUrl: c.issuerUrl ?? '', jurisdiction: c.jurisdiction ?? 'CA', recognition: c.recognition ?? 'unverified', regulated: c.regulated ?? false, validityMonths: c.validityMonths ?? null, renewal: c.renewal ?? '', spellings: JSON.stringify((c.spellings ?? []).map((s) => s.toLowerCase())), datasetId: dataset.id },
    });
    credentialIds.set(c.slug, row.id);
    const keep: string[] = [];
    for (const skillName of c.skills ?? []) {
      const skillId = await ensureSkill(client, skillName, created);
      keep.push(skillId);
      await client.credentialSkill.upsert({ where: { credentialId_skillId: { credentialId: row.id, skillId } }, create: { credentialId: row.id, skillId, datasetId: dataset.id }, update: { datasetId: dataset.id } });
    }
    // A skill the file no longer lists is no longer stated (review finding L11).
    await client.credentialSkill.deleteMany({ where: { credentialId: row.id, skillId: { notIn: keep } } });
  }
  const providerIds = new Map<string, string>();
  for (const p of file.providers) {
    if (!owned('provider', p.slug, await client.learningProvider.findUnique({ where: { slug: p.slug }, select: { datasetId: true } }))) continue;
    const row = await client.learningProvider.upsert({
      where: { slug: p.slug },
      create: { slug: p.slug, name: p.name, kind: p.kind, country: p.country ?? 'CA', region: p.region ?? '', url: p.url ?? '', datasetId: dataset.id },
      update: { name: p.name, kind: p.kind, country: p.country ?? 'CA', region: p.region ?? '', url: p.url ?? '', datasetId: dataset.id },
    });
    providerIds.set(p.slug, row.id);
  }
  let offerings = 0;
  for (const o of file.offerings) {
    const providerId = providerIds.get(o.provider);
    if (!providerId) {
      conflicts.push(`offering:${o.slug} (provider ${o.provider} belongs to another dataset)`);
      continue;
    }
    if (!owned('offering', o.slug, await client.learningOffering.findUnique({ where: { slug: o.slug }, select: { datasetId: true } }))) continue;
    const data = { providerId, credentialId: o.credential ? credentialIds.get(o.credential) ?? null : null, title: o.title, deliveryMode: o.deliveryMode ?? 'online', durationHours: o.durationHours ?? null, durationWeeks: o.durationWeeks ?? null, costCents: o.costCents ?? null, currency: o.currency ?? 'CAD', prerequisites: o.prerequisites ?? '', jurisdiction: o.jurisdiction ?? 'CA', url: o.url ?? '', active: true, datasetId: dataset.id };
    const row = await client.learningOffering.upsert({ where: { slug: o.slug }, create: { slug: o.slug, ...data }, update: data });
    offerings += 1;
    const keep: string[] = [];
    for (const skillName of o.skills ?? []) {
      const skillId = await ensureSkill(client, skillName, created);
      keep.push(skillId);
      await client.offeringSkill.upsert({ where: { offeringId_skillId: { offeringId: row.id, skillId } }, create: { offeringId: row.id, skillId }, update: {} });
    }
    await client.offeringSkill.deleteMany({ where: { offeringId: row.id, skillId: { notIn: keep } } });
  }
  const unmatchedNoc: string[] = [];
  let occupationCredentials = 0;
  for (const r of file.occupationCredentials) {
    const code = await client.occupationCode.findFirst({ where: { scheme: 'NOC2021', code: r.noc }, select: { occupationId: true } });
    if (!code) {
      if (!unmatchedNoc.includes(r.noc)) unmatchedNoc.push(r.noc);
      continue;
    }
    const credentialId = credentialIds.get(r.credential);
    if (!credentialId) {
      conflicts.push(`occupationCredential:${r.noc}/${r.credential} (credential belongs to another dataset)`);
      continue;
    }
    const jurisdiction = r.jurisdiction ?? 'CA';
    await client.occupationCredential.upsert({
      where: { occupationId_credentialId_jurisdiction: { occupationId: code.occupationId, credentialId, jurisdiction } },
      create: { occupationId: code.occupationId, credentialId, requirement: r.requirement, jurisdiction, note: r.note ?? '', datasetId: dataset.id },
      update: { requirement: r.requirement, note: r.note ?? '', datasetId: dataset.id },
    });
    occupationCredentials += 1;
  }
  let occupationSkills = 0;
  for (const r of file.occupationSkills ?? []) {
    const code = await client.occupationCode.findFirst({ where: { scheme: 'NOC2021', code: r.noc }, select: { occupationId: true } });
    if (!code) {
      if (!unmatchedNoc.includes(r.noc)) unmatchedNoc.push(r.noc);
      continue;
    }
    const skillId = await ensureSkill(client, r.skill, created);
    // An occupation-skill row another source wrote (a Stage 04 OaSIS load, another learning
    // dataset) is neither overwritten nor re-parented; it is reported.
    const existingSkill = await client.occupationSkill.findUnique({ where: { occupationId_skillId: { occupationId: code.occupationId, skillId } }, select: { datasetId: true, source: true } });
    if (existingSkill && (existingSkill.datasetId ?? null) !== dataset.id) {
      conflicts.push(`occupationSkill:${r.noc}/${r.skill} (source ${existingSkill.source})`);
      continue;
    }
    await client.occupationSkill.upsert({
      where: { occupationId_skillId: { occupationId: code.occupationId, skillId } },
      create: { occupationId: code.occupationId, skillId, importance: r.importance ?? null, level: r.level ?? null, source: datasetKey, datasetId: dataset.id },
      update: { importance: r.importance ?? null, level: r.level ?? null, source: datasetKey, datasetId: dataset.id },
    });
    occupationSkills += 1;
  }
  // rowCount is what the dataset holds NOW, recounted, so a re-load is idempotent (review finding L11).
  const [nc, np, no, noc, nos] = await Promise.all([
    client.credential.count({ where: { datasetId: dataset.id } }),
    client.learningProvider.count({ where: { datasetId: dataset.id } }),
    client.learningOffering.count({ where: { datasetId: dataset.id } }),
    client.occupationCredential.count({ where: { datasetId: dataset.id } }),
    client.occupationSkill.count({ where: { datasetId: dataset.id } }),
  ]);
  await client.taxonomyDataset.update({ where: { id: dataset.id }, data: { ingestedAt: new Date(), rowCount: nc + np + no + noc + nos } });
  return { datasetKey, credentials: credentialIds.size, providers: providerIds.size, offerings, skillsCreated: created.n, occupationCredentials, occupationSkills, unmatchedNoc, conflicts };
}
