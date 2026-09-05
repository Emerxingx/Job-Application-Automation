-- Stage 15 (ADR-0010, ADR-0030): entitlement state apart from payment state.
-- Additive: a new table; nothing existing changes.
-- CreateTable
CREATE TABLE "Entitlement" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "organizationId" TEXT,
    "capability" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "quantity" INTEGER,
    "source" TEXT NOT NULL,
    "sourceRef" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedBy" TEXT NOT NULL DEFAULT 'system',
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "revokedReason" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Entitlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Entitlement_dedupeKey_key" ON "Entitlement"("dedupeKey");

-- CreateIndex
CREATE INDEX "Entitlement_userId_capability_revokedAt_idx" ON "Entitlement"("userId", "capability", "revokedAt");

-- CreateIndex
CREATE INDEX "Entitlement_organizationId_capability_revokedAt_idx" ON "Entitlement"("organizationId", "capability", "revokedAt");

-- CreateIndex
CREATE INDEX "Entitlement_source_sourceRef_idx" ON "Entitlement"("source", "sourceRef");

-- AddForeignKey
ALTER TABLE "Entitlement" ADD CONSTRAINT "Entitlement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Entitlement" ADD CONSTRAINT "Entitlement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

