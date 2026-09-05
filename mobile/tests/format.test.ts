import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeDevice } from '../src/auth/device';
import { apiBaseUrl, assertTransportSecure } from '../src/config';
import { eligibilityLabel, formatAge, formatSalary, humanise, scoreBand, statusLabel } from '../src/lib/format';

describe('format', () => {
  it('salary reads as a range, a bound, or an honest absence', () => {
    assert.equal(formatSalary(90000, 120000, 'CAD'), 'CAD 90,000 – CAD 120,000');
    assert.equal(formatSalary(90000, 90000, 'CAD'), 'CAD 90,000');
    assert.equal(formatSalary(90000, null, 'USD'), 'From USD 90,000');
    assert.equal(formatSalary(null, 120000, 'USD'), 'Up to USD 120,000');
    assert.equal(formatSalary(null, null, 'CAD'), 'Salary not stated');
  });
  it('ages are human', () => {
    const now = new Date('2026-09-05T12:00:00Z');
    assert.equal(formatAge('2026-09-05T11:59:40Z', now), 'just now');
    assert.equal(formatAge('2026-09-05T11:30:00Z', now), '30 minutes ago');
    assert.equal(formatAge('2026-09-05T09:00:00Z', now), '3 hours ago');
    assert.equal(formatAge('2026-09-01T12:00:00Z', now), '4 days ago');
    assert.equal(formatAge('2026-09-06T12:00:00Z', now), 'just now', 'a future timestamp is not negative');
  });
  it('labels never expose raw tokens and never invent a state', () => {
    assert.equal(statusLabel('ready_to_submit'), 'Ready to submit');
    assert.equal(statusLabel('some_new_state'), 'some new state');
    assert.equal(humanise('work_authorization'), 'Work authorization');
    assert.equal(eligibilityLabel('unknown'), 'Some requirements could not be checked');
    assert.equal(eligibilityLabel(undefined), 'Not evaluated yet');
    assert.deepEqual([scoreBand(80), scoreBand(60), scoreBand(10)], ['strong', 'good', 'weak']);
  });
});

describe('device descriptor', () => {
  it('names the device without identifying the person, and falls back per platform', () => {
    assert.deepEqual(describeDevice('ios', "Avi's iPhone"), { name: "Avi's iPhone", platform: 'ios' });
    assert.deepEqual(describeDevice('android', null), { name: 'Android phone', platform: 'android' });
    assert.deepEqual(describeDevice('windows', ''), { name: 'Device', platform: 'other' });
    assert.equal(describeDevice('web', 'x'.repeat(200)).name.length, 80);
  });
});

describe('config', () => {
  it('reads the public base URL, strips slashes, refuses non-http and plain http in release', () => {
    assert.equal(apiBaseUrl({}), 'http://localhost:3000');
    assert.equal(apiBaseUrl({ EXPO_PUBLIC_API_BASE_URL: 'https://app.example/' }), 'https://app.example');
    assert.throws(() => apiBaseUrl({ EXPO_PUBLIC_API_BASE_URL: 'app.example' }), /http\(s\)/);
    assert.throws(() => assertTransportSecure('http://app.example', false), /https/);
    assert.doesNotThrow(() => assertTransportSecure('http://localhost:3000', true));
    assert.doesNotThrow(() => assertTransportSecure('https://app.example', false));
  });
});
