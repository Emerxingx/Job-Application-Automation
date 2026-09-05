import { scimJson, scimRoute } from '@/lib/scim/route';

/** GET /api/scim/v2/ServiceProviderConfig - what this endpoint supports (RFC 7643 §5): Users only, no bulk, no sorting, `userName eq` filtering, PATCH on `active` and `name.formatted`. */
export const GET = scimRoute(async () =>
  scimJson({
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    documentationUri: 'https://github.com/Emerxingx/Job-Application-Automation/blob/main/docs/adr/ADR-0035-enterprise-tenant-controls.md',
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'A token issued by JobPilot staff for one organisation.' }],
    meta: { resourceType: 'ServiceProviderConfig', location: '/api/scim/v2/ServiceProviderConfig' },
  }),
);
