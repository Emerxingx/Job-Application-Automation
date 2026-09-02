import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isPublicPath } from '../src/proxy';

/**
 * These are NEGATIVE authorisation tests. The point is not that the public
 * routes work — it is that everything else is closed WITHOUT anyone having
 * remembered to close it, which is the S-02 failure mode.
 */

describe('proxy (edge gate) public surface — deny by default', () => {
  it('treats an invented route as PROTECTED', () => {
    // The whole purpose of the gate: a route nobody has thought about yet.
    assert.equal(isPublicPath('/api/some/route/added/next/quarter'), false);
    assert.equal(isPublicPath('/dashboard/a-page-that-does-not-exist-yet'), false);
    assert.equal(isPublicPath('/an-entirely-new-top-level-section'), false);
  });

  it('protects every candidate surface', () => {
    for (const p of [
      '/dashboard',
      '/dashboard/jobs',
      '/dashboard/applications/abc',
      '/dashboard/billing',
      '/dashboard/settings',
      '/onboarding',
      '/api/profile',
      '/api/resume',
      '/api/apply',
      '/api/scan',
      '/api/agents',
      '/api/billing/checkout',
      '/api/interview-prep',
      '/api/invoices',
      '/api/exports/applications',
      '/api/integrations/keys',
    ]) {
      assert.equal(isPublicPath(p), false, `${p} must require a session`);
    }
  });

  it('protects the staff console, which reads other people PII', () => {
    for (const p of [
      '/console',
      '/console/customers',
      '/console/customers/xyz',
      '/console/invoices',
      '/console/revenue',
      '/api/console/customers',
      '/api/console/tickets',
      '/console/exports/customers',
    ]) {
      assert.equal(isPublicPath(p), false, `${p} must require a session`);
    }
  });

  it('allows exactly the routes needed to obtain or clear a session', () => {
    assert.equal(isPublicPath('/'), true);
    assert.equal(isPublicPath('/login'), true);
    assert.equal(isPublicPath('/signup'), true);
    assert.equal(isPublicPath('/api/auth/login'), true);
    assert.equal(isPublicPath('/api/auth/signup'), true);
    // Logout must work with an expired cookie or a user cannot clear it.
    assert.equal(isPublicPath('/api/auth/logout'), true);
  });

  it('allows surfaces that authenticate by another mechanism', () => {
    // Signature-verified, not session-authenticated.
    assert.equal(isPublicPath('/api/webhooks/stripe'), true);
    // Bearer API key, not a cookie.
    assert.equal(isPublicPath('/api/v1/jobs'), true);
    assert.equal(isPublicPath('/api/v1/applications'), true);
    // Payload's own auth and its own identity domain.
    assert.equal(isPublicPath('/admin'), true);
    assert.equal(isPublicPath('/api/cms/graphql'), true);
  });

  it('does not let the root entry make everything public', () => {
    // A naive startsWith('/') check would make the whole site public. This is
    // the regression that would silently disable the entire gate.
    assert.equal(isPublicPath('/'), true);
    assert.equal(isPublicPath('/dashboard'), false);
    assert.equal(isPublicPath('/anything'), false);
  });

  it('does not let a lookalike prefix slip through', () => {
    // These START WITH a public-looking string but are not the public route.
    assert.equal(isPublicPath('/api/authorise-payment'), false);
    assert.equal(isPublicPath('/api/v2/jobs'), false);
    assert.equal(isPublicPath('/administrative-reports'), false);
    assert.equal(isPublicPath('/logout-everyone'), false);
  });
});
