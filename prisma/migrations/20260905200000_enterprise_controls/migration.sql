-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "allowedEmailDomains" TEXT NOT NULL DEFAULT '[]',
ADD COLUMN     "requireSso" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sessionMaxHours" INTEGER,
ADD COLUMN     "verifiedAt" TIMESTAMP(3),
ADD COLUMN     "verifiedByEmail" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "SsoConnection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "protocol" TEXT NOT NULL DEFAULT 'oidc',
    "issuer" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecretCiphertext" TEXT NOT NULL,
    "clientSecretIv" TEXT NOT NULL,
    "clientSecretTag" TEXT NOT NULL,
    "clientSecretKeyVersion" INTEGER NOT NULL DEFAULT 1,
    "emailDomain" TEXT NOT NULL,
    "jitProvisioning" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'disabled',
    "createdByEmail" TEXT NOT NULL DEFAULT '',
    "lastSignInAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SsoConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScimToken" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "createdByEmail" TEXT NOT NULL DEFAULT '',
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScimToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SsoConnection_organizationId_key" ON "SsoConnection"("organizationId");

-- CreateIndex
CREATE INDEX "SsoConnection_emailDomain_status_idx" ON "SsoConnection"("emailDomain", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ScimToken_tokenHash_key" ON "ScimToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ScimToken_organizationId_revokedAt_idx" ON "ScimToken"("organizationId", "revokedAt");

-- AddForeignKey
ALTER TABLE "SsoConnection" ADD CONSTRAINT "SsoConnection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScimToken" ADD CONSTRAINT "ScimToken_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

