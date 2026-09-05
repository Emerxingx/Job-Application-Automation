-- Stage 14: an API key is either an integration key (minted on the web, for
-- servers) or a device key (minted by a mobile sign-in, revoked with the
-- sessions on password change). Additive; existing rows are integrations.
-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'integration',
ADD COLUMN     "platform" TEXT NOT NULL DEFAULT '';

