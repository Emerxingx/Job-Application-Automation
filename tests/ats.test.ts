import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { atsDisplayName, detectAts } from '../src/lib/providers/apply/ats';

describe('detectAts', () => {
  it('identifies a Greenhouse board and posting', () => {
    const target = detectAts('https://boards.greenhouse.io/acmecorp/jobs/4012345');
    assert.equal(target?.vendor, 'greenhouse');
    assert.equal(target?.tenant, 'acmecorp');
    assert.equal(target?.postingId, '4012345');
    assert.equal(target?.submittable, true);
  });

  it('handles the newer job-boards Greenhouse host', () => {
    const target = detectAts('https://job-boards.greenhouse.io/acmecorp/jobs/999');
    assert.equal(target?.vendor, 'greenhouse');
    assert.equal(target?.postingId, '999');
  });

  it('falls back to the gh_jid query parameter when the path has no id', () => {
    const target = detectAts('https://boards.greenhouse.io/acmecorp?gh_jid=778899');
    assert.equal(target?.vendor, 'greenhouse');
    assert.equal(target?.postingId, '778899');
  });

  it('identifies a Lever posting', () => {
    const target = detectAts('https://jobs.lever.co/shopify/2f1a-4bcd-9012');
    assert.equal(target?.vendor, 'lever');
    assert.equal(target?.tenant, 'shopify');
    assert.equal(target?.postingId, '2f1a-4bcd-9012');
    assert.equal(target?.submittable, true);
  });

  it('recognises vendors it cannot submit to, without claiming it can', () => {
    for (const [url, vendor] of [
      ['https://jobs.ashbyhq.com/acme/abc-123', 'ashby'],
      ['https://apply.workable.com/acme/j/ABC123', 'workable'],
      ['https://jobs.smartrecruiters.com/acme/74000', 'smartrecruiters'],
      ['https://acme.wd1.myworkdayjobs.com/en-US/careers/job/R-123', 'workday'],
      ['https://acme.bamboohr.com/careers/42', 'bamboohr'],
      ['https://acme.applytojob.com/apply/xyz', 'jazzhr'],
      ['https://acme.recruitee.com/o/data-analyst', 'recruitee'],
    ] as const) {
      const target = detectAts(url);
      assert.equal(target?.vendor, vendor, `expected ${vendor} for ${url}`);
      assert.equal(target?.submittable, false, `${vendor} must not be marked submittable`);
    }
  });

  it('returns null for non-ATS and malformed URLs', () => {
    assert.equal(detectAts('https://www.linkedin.com/jobs/view/12345'), null);
    assert.equal(detectAts('https://careers.example.com/apply'), null);
    assert.equal(detectAts('not a url'), null);
    assert.equal(detectAts(''), null);
  });

  it('does not match a lookalike host that merely contains a vendor name', () => {
    // greenhouse.io.evil.com must not be treated as Greenhouse.
    assert.equal(detectAts('https://greenhouse.io.evil.com/acme/jobs/1'), null);
    assert.equal(detectAts('https://notlever.co.uk/acme/1'), null);
  });

  it('names every vendor it can detect', () => {
    const vendors = [
      'greenhouse', 'lever', 'ashby', 'workable',
      'smartrecruiters', 'workday', 'bamboohr', 'jazzhr', 'recruitee',
    ] as const;
    for (const v of vendors) {
      assert.ok(atsDisplayName(v).length > 0, `${v} has no display name`);
    }
  });
});
