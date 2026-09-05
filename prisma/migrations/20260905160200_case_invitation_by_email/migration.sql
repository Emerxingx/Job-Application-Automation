-- Stage 17 review (ADR-0032, amended): an invitation is addressed to an email
-- and never resolved against the accounts table; the client is linked when
-- they accept; every engagement is its own Case row.
--
-- Hand-written so an existing invited/open row (none exist outside a test
-- database - the stage is unreleased) keeps a usable address: the column is
-- backfilled from the linked account before it becomes NOT NULL.

ALTER TABLE "Case" ADD COLUMN "invitedEmail" TEXT;
ALTER TABLE "Case" ADD COLUMN "invitedName" TEXT NOT NULL DEFAULT '';

UPDATE "Case" c SET "invitedEmail" = u."email", "invitedName" = CASE WHEN c."status" IN ('open', 'closed') THEN u."fullName" ELSE '' END
  FROM "User" u WHERE u."id" = c."clientUserId" AND c."invitedEmail" IS NULL;
UPDATE "Case" SET "invitedEmail" = '' WHERE "invitedEmail" IS NULL;

ALTER TABLE "Case" ALTER COLUMN "invitedEmail" SET NOT NULL;

-- The person is linked at acceptance, so an invitation carries no user id.
ALTER TABLE "Case" DROP CONSTRAINT "Case_clientUserId_fkey";
ALTER TABLE "Case" ALTER COLUMN "clientUserId" DROP NOT NULL;
ALTER TABLE "Case" ADD CONSTRAINT "Case_clientUserId_fkey" FOREIGN KEY ("clientUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One row per engagement: the (organisation, client) key is no longer unique.
DROP INDEX "Case_organizationId_clientUserId_key";
CREATE INDEX "Case_organizationId_clientUserId_idx" ON "Case"("organizationId", "clientUserId");
CREATE INDEX "Case_organizationId_invitedEmail_idx" ON "Case"("organizationId", "invitedEmail");
