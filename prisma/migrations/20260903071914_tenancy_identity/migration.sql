-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "aiProcessingPolicy" TEXT NOT NULL DEFAULT 'EXTERNAL_AI_PROHIBITED',
ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'personal';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "passwordChangedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'password',
    "assuranceLevel" TEXT NOT NULL DEFAULT 'aal1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserIdentity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "email" TEXT,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAuthenticatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'signup',
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Session_userId_revokedAt_idx" ON "Session"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "UserIdentity_userId_idx" ON "UserIdentity"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserIdentity_provider_subject_key" ON "UserIdentity"("provider", "subject");

-- CreateIndex
CREATE INDEX "ConsentRecord_userId_purpose_idx" ON "ConsentRecord"("userId", "purpose");

-- CreateIndex
CREATE INDEX "Organization_type_idx" ON "Organization"("type");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserIdentity" ADD CONSTRAINT "UserIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Backfill (hand-written; reviewed): every existing user gets a PERSONAL
-- organisation and an owner membership of it.
--
-- WHY. Stage 01 gives tenancy exactly one shape — a row belongs to an
-- organisation that a user is a member of — so that the authorisation service
-- and the RLS policies do not need a second "individual" branch. A candidate's
-- personal workspace is that organisation. New accounts get theirs at signup
-- (src/lib/tenancy/organizations.ts); accounts that predate this migration get
-- theirs here.
--
-- IDs are derived from the user id rather than generated, so re-running this
-- statement is idempotent (the NOT EXISTS guard) and the mapping is
-- reconstructible from the user table alone. `slug` is unique per user for the
-- same reason. `billingEmail` snapshots the user's email because the column is
-- NOT NULL; the Organization row is not the billing source of truth for a
-- personal workspace (Invoice.userId is).
--
-- RECOVERY. Additive only: new rows, no updates to existing ones. Forward-fix
-- is to delete the rows this inserted (they are recognisable by their id
-- prefixes); nothing else references them at the time this runs.
-- ---------------------------------------------------------------------------
INSERT INTO "Organization" ("id", "name", "slug", "type", "billingEmail", "status", "createdAt", "updatedAt")
SELECT 'org_personal_' || u."id",
       u."fullName",
       'personal-' || u."id",
       'personal',
       u."email",
       'active',
       CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP
  FROM "User" u
 WHERE NOT EXISTS (
         SELECT 1 FROM "Organization" o WHERE o."id" = 'org_personal_' || u."id"
       );

INSERT INTO "Membership" ("id", "organizationId", "userId", "role", "invitedAt", "acceptedAt", "createdAt", "updatedAt")
SELECT 'mem_personal_' || u."id",
       'org_personal_' || u."id",
       u."id",
       'owner',
       CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP
  FROM "User" u
 WHERE NOT EXISTS (
         SELECT 1 FROM "Membership" m
          WHERE m."organizationId" = 'org_personal_' || u."id" AND m."userId" = u."id"
       );
