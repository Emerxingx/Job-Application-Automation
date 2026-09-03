import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  AssistedOnlyApplyProvider,
  DefaultApplyProvider,
  MockApplyProvider,
  getApplyProvider,
  resetApplyProvider,
} from '../src/lib/providers/apply';
import type { ApplyRequest } from '../src/lib/providers/apply';

function request(overrides: Partial<ApplyRequest['job']> = {}): ApplyRequest {
  return {
    job: {
      title: 'Senior Data Analyst',
      company: 'Acme',
      applyUrl: 'https://careers.example.com/apply/123',
      applyMethod: 'external',
      ...overrides,
    },
    resumeText: 'ALEX MORGAN\nData Analyst\nSQL, Python',
    coverLetter: 'Dear Hiring Team,\n\nI am writing to apply…',
    applicant: {
      fullName: 'Alex Morgan',
      firstName: 'Alex',
      lastName: 'Morgan',
      email: 'alex@example.com',
      phone: '+1 (416) 555-0142',
      location: 'Toronto, CA',
      linkedinUrl: 'https://linkedin.com/in/alexmorgan',
      workAuthorization: 'Canadian Citizen',
      requiresSponsorship: false,
    },
  };
}

describe('apply engine', () => {
  beforeEach(() => resetApplyProvider());

  it('prepares an assisted application for a non-ATS posting', async () => {
    const outcome = await new DefaultApplyProvider().apply(request());
    assert.equal(outcome.ok, true);
    assert.equal(outcome.channel, 'assisted');
    assert.ok(outcome.assisted, 'expected an assisted payload');
    assert.equal(outcome.assisted?.applyUrl, 'https://careers.example.com/apply/123');
  });

  it('falls back to assisted on a supported ATS when no employer credential exists', async () => {
    // No ATS_GREENHOUSE_* variable is set, so submission must not be attempted.
    const outcome = await new DefaultApplyProvider().apply(
      request({ applyUrl: 'https://boards.greenhouse.io/acme/jobs/4012345' }),
    );
    assert.equal(outcome.channel, 'assisted');
    assert.equal(outcome.ats, 'greenhouse');
    assert.match(outcome.assisted?.guidance ?? '', /Greenhouse/);
  });

  it('carries every known applicant field into the prepared set', async () => {
    const outcome = await new DefaultApplyProvider().apply(request());
    const keys = (outcome.assisted?.fields ?? []).map((f) => f.key);
    for (const expected of [
      'full_name', 'first_name', 'last_name', 'email', 'phone',
      'location', 'linkedin', 'work_authorization', 'sponsorship',
      'resume', 'cover_letter',
    ]) {
      assert.ok(keys.includes(expected), `missing prepared field: ${expected}`);
    }
  });

  it('marks long values as multiline so the UI renders them as text areas', async () => {
    const outcome = await new DefaultApplyProvider().apply(request());
    const resume = outcome.assisted?.fields.find((f) => f.key === 'resume');
    const email = outcome.assisted?.fields.find((f) => f.key === 'email');
    assert.equal(resume?.multiline, true);
    assert.notEqual(email?.multiline, true);
  });

  it('omits fields the applicant has not provided', async () => {
    const req = request();
    delete req.applicant.phone;
    delete req.applicant.linkedinUrl;
    const outcome = await new AssistedOnlyApplyProvider().apply(req);
    const keys = (outcome.assisted?.fields ?? []).map((f) => f.key);
    assert.ok(!keys.includes('phone'));
    assert.ok(!keys.includes('linkedin'));
    assert.ok(keys.includes('email'));
  });

  it('reports unavailable rather than failing when a posting has no apply link', async () => {
    const outcome = await new DefaultApplyProvider().apply(request({ applyUrl: '' }));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.channel, 'unavailable');
    assert.match(outcome.failureReason ?? '', /saved in your folder/);
  });

  it('never submits programmatically in assisted-only mode', async () => {
    const outcome = await new AssistedOnlyApplyProvider().apply(
      request({ applyUrl: 'https://jobs.lever.co/acme/abc-123' }),
    );
    assert.equal(outcome.channel, 'assisted');
    assert.equal(outcome.ats, 'lever');
  });

  it('preparation NEVER submits, even when an employer credential exists — submission is a separate, instructed step', async () => {
    const saved = process.env.ATS_GREENHOUSE_DEFAULT;
    process.env.ATS_GREENHOUSE_DEFAULT = 'board-token-for-test';
    try {
      const provider = new DefaultApplyProvider();
      const req = request({ applyUrl: 'https://boards.greenhouse.io/acme/jobs/4012345' });
      const outcome = await provider.apply(req);
      assert.equal(outcome.channel, 'assisted', 'apply() prepares; it does not post to the board');
      assert.equal(outcome.confirmation, undefined);
      assert.equal(provider.canSubmit(req), true, 'the credential makes an instructed submission possible');
      assert.equal(provider.canSubmit(request({ applyUrl: 'https://jobs.lever.co/acme/abc-123' })), false, 'no Lever credential');
      assert.equal(await provider.submit(request({ applyUrl: 'https://jobs.lever.co/acme/abc-123' })), null);
      const strict = new AssistedOnlyApplyProvider();
      assert.equal(strict.canSubmit(), false, 'assisted-only never submits whatever credentials exist');
      assert.equal(await strict.submit(), null);
    } finally {
      if (saved === undefined) delete process.env.ATS_GREENHOUSE_DEFAULT;
      else process.env.ATS_GREENHOUSE_DEFAULT = saved;
    }
  });

  it('produces a deterministic mock outcome for the demo build — prepared first, submitted only on instruction', async () => {
    const provider = new MockApplyProvider();
    const preparedA = await provider.apply(request());
    assert.equal(preparedA.channel, 'assisted', 'even the mock prepares rather than claiming a submission');
    assert.ok(preparedA.assisted?.fields.length);
    const a = await provider.submit(request());
    const b = await provider.submit(request());
    assert.equal(a?.ok, b?.ok);
    assert.equal(a?.confirmation, b?.confirmation);
    assert.equal(a?.channel, 'ats_api');
  });

  describe('provider resolution', () => {
    const original = { ...process.env };
    beforeEach(() => {
      process.env = { ...original };
      resetApplyProvider();
    });

    it('defaults to mock when the job source is mock', () => {
      process.env.JOB_PROVIDER = 'mock';
      delete process.env.APPLY_MODE;
      assert.equal(getApplyProvider().name, 'mock');
    });

    it('defaults to auto once a live job source is configured', () => {
      process.env.JOB_PROVIDER = 'adzuna';
      delete process.env.APPLY_MODE;
      assert.equal(getApplyProvider().name, 'default');
    });

    it('honours an explicit assisted mode', () => {
      process.env.APPLY_MODE = 'assisted';
      assert.equal(getApplyProvider().name, 'assisted-only');
    });

    it('falls back to the safest provider on an unknown mode', () => {
      process.env.APPLY_MODE = 'yolo';
      assert.equal(getApplyProvider().name, 'assisted-only');
    });
  });
});
