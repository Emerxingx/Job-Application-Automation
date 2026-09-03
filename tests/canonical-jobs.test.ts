/**
 * Stage 06 — the canonical job, measured (pure; no database).
 *
 * Normalisation goldens: every canonical field of every fixture posting is
 * asserted exactly. Dedup: the fixture labels which postings are the same
 * job and which are distinct; precision and recall of `canonicalHash`
 * equality over EVERY pair are computed and printed, and both must be 1.0
 * on the labelled set — a regression in either fails here before it
 * reaches the database.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { NormalizedPosting } from '../src/lib/connectors/types';
import {
  UNDISCLOSED_EMPLOYER,
  canonicalHash,
  canonicalIdentityStrength,
  canonicalize,
  educationRequirements,
  experienceYears,
  normalizeCompany,
  normalizeJobTitle,
  occupationFamily,
  postalRegion,
  sponsorship,
  workAuthorization,
} from '../src/lib/jobs/canonical';

interface Case {
  name: string;
  posting: NormalizedPosting;
  expected: Record<string, unknown>;
  sameJobAs?: string;
  differentJobFrom?: string;
}
const fixture = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'canonical-postings.json'), 'utf8')) as { cases: Case[] };

describe('canonical job — normalisation goldens', () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      const got = canonicalize(c.posting);
      const { canonicalHash: _hash, ...fields } = got;
      void _hash;
      assert.deepEqual(fields, c.expected);
      assert.deepEqual(canonicalize(c.posting), got, 'deterministic');
    });
  }

  it('title: seniority kept, qualifiers / requisition ids / work mode / employer / place segments dropped', () => {
    assert.equal(normalizeJobTitle('Senior Data Analyst (Remote) - Req #4521'), 'senior data analyst');
    assert.equal(normalizeJobTitle('Data Analyst'), 'data analyst');
    assert.equal(normalizeJobTitle('Staff Software Engineer - Austin, TX - Acme Corp (Job ID 88231)', 'Acme Corporation', 'Austin, Texas'), 'staff software engineer');
    assert.equal(normalizeJobTitle('Product Manager | Hybrid | Toronto', 'X', 'Toronto, ON'), 'product manager');
    assert.equal(normalizeJobTitle('Analyst – Finance'), 'analyst finance', 'a department is not noise');
    assert.equal(normalizeJobTitle('Data Analyst - Req #R-2024-1234'), 'data analyst', 'a prefixed requisition id');
    assert.equal(normalizeJobTitle('Data Analyst Req #3f9a1b2c'), 'data analyst', 'an alphanumeric requisition id');
    assert.equal(normalizeJobTitle('Engineer, Job ID JR0012345'), 'engineer');
    assert.equal(normalizeJobTitle('Engineer #88231'), 'engineer');
    assert.equal(normalizeJobTitle('Sr. Developer'), normalizeJobTitle('Senior Developer'), 'abbreviations expand');
    assert.equal(normalizeJobTitle('Jr. Mgr., Operations'), 'junior manager operations');
    assert.equal(normalizeJobTitle('Position: Registered Nurse 2'), 'registered nurse 2');
    assert.notEqual(normalizeJobTitle('Senior Data Analyst'), normalizeJobTitle('Data Analyst'));
  });

  it('company: legal-form suffixes and punctuation removed, never emptied', () => {
    assert.equal(normalizeCompany('Maple Analytics Inc.'), 'maple analytics');
    assert.equal(normalizeCompany('Acme Corporation'), normalizeCompany('ACME Corp'));
    assert.equal(normalizeCompany('Co.'), 'co', 'a name made only of a suffix keeps its base form');
    assert.equal(normalizeCompany('Canada Life'), 'canada life', 'a country word inside the name is the name');
    assert.equal(normalizeCompany('Air Canada'), 'air canada');
    assert.equal(normalizeCompany('Groupe SA'), 'groupe');
    assert.equal(normalizeCompany('The Home Depot Canada Inc.'), 'home depot canada');
  });

  it('region: province / state codes and names, postal codes, remote, known cities, unknown → null', () => {
    assert.equal(postalRegion('Toronto, ON M5V 2T6', 'CA'), 'CA-ON/toronto');
    assert.equal(postalRegion('Toronto, Ontario, Canada', 'CA'), 'CA-ON/toronto');
    assert.equal(postalRegion('Montréal, QC', 'CA'), 'CA-QC/montréal');
    assert.equal(postalRegion('Vancouver', 'CA'), 'CA-BC/vancouver', 'a known city alone');
    assert.equal(postalRegion('Austin, TX 78701', 'US'), 'US-TX/austin');
    assert.equal(postalRegion('New York, NY', 'US'), 'US-NY/new-york');
    assert.equal(postalRegion('Remote', 'CA'), 'remote');
    assert.equal(postalRegion('Remote - Canada', 'CA'), 'remote');
    assert.equal(postalRegion('', 'CA', 'remote'), 'remote');
    assert.equal(postalRegion('Somewhere Unknown', 'CA'), null);
    assert.equal(postalRegion('Toronto, ON', 'US'), null, 'a Canadian city on a US posting is not guessed');
    assert.equal(postalRegion('Hybrid - Toronto, ON', 'CA'), 'CA-ON/toronto', 'a work mode is not a city');
    assert.equal(postalRegion('Washington, DC', 'US'), 'US-DC/washington');
    assert.equal(postalRegion('Quebec City, QC', 'CA'), 'CA-QC/quebec-city');
  });

  it('experience, authorisation and sponsorship state only what is written', () => {
    assert.deepEqual(experienceYears('3+ years'), { min: 3, max: null });
    assert.deepEqual(experienceYears('5-8 years, or 10+ yrs in a related field'), { min: 5, max: 8 });
    assert.deepEqual(experienceYears('a great team'), { min: null, max: null });
    assert.deepEqual(experienceYears('established 2024 years'), { min: null, max: null }, 'anchored: a four-digit number is not a year count');
    assert.deepEqual(experienceYears('over 100 years of history; 2 years experience'), { min: 2, max: null });
    assert.deepEqual(educationRequirements('Our office is in Boston, MA. BA or BS in Statistics. B.A. preferred.'), ['ba', 'bs'], 'a state abbreviation is not a degree; a degree context is, and B.A. collapses to ba');
    assert.equal(workAuthorization('Must be legally authorized to work in Canada'), 'authorization_required');
    assert.equal(workAuthorization('Only Canadian citizens and permanent residents will be considered'), 'citizenship_or_pr_required');
    assert.equal(workAuthorization('Reliability status clearance is required'), 'security_clearance_required');
    assert.equal(workAuthorization('We welcome applicants from everywhere'), null);
    assert.equal(workAuthorization('Canadian citizenship is not required.'), null, 'a negated requirement is not a requirement');
    assert.equal(workAuthorization('No security clearance required.'), null);
    assert.equal(workAuthorization('Secret clearance is an asset.'), null, 'a preference is not a requirement');
    assert.equal(workAuthorization('Must have the right to work in the UK.'), null, 'only Canada and the US are modelled');
    assert.equal(workAuthorization('Clearance is not required. Must be legally authorized to work in Canada.'), 'authorization_required', 'each sentence on its own');
    assert.equal(sponsorship('We are unable to sponsor visas at this time'), 'not_offered');
    assert.equal(sponsorship('Visa sponsorship available for the right candidate'), 'offered');
    assert.equal(sponsorship('Sponsorship is not available'), 'not_offered');
    assert.equal(sponsorship('Great benefits'), 'unknown');
    assert.equal(sponsorship('We will not discriminate on any ground. Sponsorship is available.'), 'offered', 'a negation in another sentence does not cross into this one');
    assert.equal(sponsorship('We sponsor work visas.'), 'offered');
    assert.equal(sponsorship('No visa sponsorship for this role.'), 'not_offered');
    assert.equal(occupationFamily('21234'), 'noc:2');
    assert.equal(occupationFamily('2123'), null);
    assert.equal(occupationFamily(null), null);
  });
});

describe('canonical job — deduplication measured on the labelled set', () => {
  it('precision and recall of canonicalHash equality over every labelled pair are both 1.0', () => {
    const byId = new Map(fixture.cases.map((c) => [c.posting.externalId, c] as const));
    const hashes = new Map(fixture.cases.map((c) => [c.posting.externalId, canonicalize(c.posting).canonicalHash] as const));
    // Ground truth: `sameJobAs` links are positives (symmetric); every other
    // pair is a negative, `differentJobFrom` links being the hard ones.
    const positives = new Set<string>();
    for (const c of fixture.cases) if (c.sameJobAs) positives.add([c.posting.externalId, c.sameJobAs].sort().join('|'));
    const ids = [...byId.keys()];
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;
    const hard: string[] = [];
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const key = [ids[i], ids[j]].sort().join('|');
        const predicted = hashes.get(ids[i]) === hashes.get(ids[j]);
        const actual = positives.has(key);
        if (predicted && actual) tp += 1;
        else if (predicted && !actual) fp += 1;
        else if (!predicted && actual) fn += 1;
        else tn += 1;
        const c = byId.get(ids[i])!;
        const d = byId.get(ids[j])!;
        if (c.differentJobFrom === ids[j] || d.differentJobFrom === ids[i]) hard.push(`${key}: predicted ${predicted ? 'same' : 'different'}`);
      }
    }
    const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
    console.log(`# dedup on ${ids.length} postings / ${tp + fp + fn + tn} pairs: tp ${tp} fp ${fp} fn ${fn} tn ${tn} — precision ${precision.toFixed(3)} recall ${recall.toFixed(3)}; hard negatives: ${hard.join('; ')}`);
    assert.equal(fp, 0, 'no two distinct jobs share a hash');
    assert.equal(fn, 0, 'every labelled duplicate pair shares a hash');
    assert.ok(tp >= 2, 'the set contains real duplicates');
  });

  it('the hash is a pure function of the canonical identity fields, insensitive to skill order, duplication and non-vocabulary skills; a weak identity never merges', () => {
    const a = { normalizedTitle: 't', normalizedCompany: 'c', postalRegion: 'CA-ON/x', country: 'CA', requiredSkills: ['sql', 'python'], preferredSkills: ['dbt'] };
    const b = { ...a, requiredSkills: ['python', 'sql', 'sql', 'python 3'], preferredSkills: ['dbt'] };
    assert.equal(canonicalHash(a), canonicalHash(b), 'a source-listed skill outside the vocabulary does not split a job');
    assert.notEqual(canonicalHash(a), canonicalHash({ ...a, country: 'US' }), 'the country is part of the identity');
    assert.notEqual(canonicalHash(a), canonicalHash({ ...a, requiredSkills: ['sql'] }));
    assert.equal(canonicalIdentityStrength(a), 'strong');
    for (const weak of [{ ...a, postalRegion: null }, { ...a, normalizedCompany: UNDISCLOSED_EMPLOYER }, { ...a, requiredSkills: [], preferredSkills: [] }, { ...a, requiredSkills: ['python 3'], preferredSkills: [] }]) {
      assert.equal(canonicalIdentityStrength(weak), 'weak');
      assert.notEqual(canonicalHash(weak, { source: 's', externalId: '1' }), canonicalHash(weak, { source: 's', externalId: '2' }), 'a weak identity is salted with the capture id');
    }
  });
});
