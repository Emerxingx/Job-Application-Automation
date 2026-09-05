import { fail } from '@/lib/api';
import { OrganizationAccessError } from '@/lib/tenancy/organizations';
import { SsoError } from '@/lib/sso/service';
import { OidcError } from '@/lib/sso/oidc';
import { SsoKeyMissingError } from '@/lib/sso/crypto';
import { ScimError } from '@/lib/scim/service';
import { AdminError } from './organizations';

/** The Stage 20 error classes → clean statuses for the console routes; anything else propagates to governanceRoute / consoleRoute. */
export function adminFail(error: unknown): Response | null {
  if (error instanceof AdminError || error instanceof SsoError || error instanceof OidcError || error instanceof ScimError || error instanceof OrganizationAccessError || error instanceof SsoKeyMissingError) return fail(error.message, error.status);
  return null;
}
