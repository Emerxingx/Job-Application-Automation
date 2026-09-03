-- Stage 13 (ADR-0012, ADR-0027): the candidate outcome, match and platform-benchmark
-- marts the candidate dashboards read instead of the transactional tables. Additive.
-- CreateTable
CREATE TABLE "CandidateOutcomeMart" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "dimension" TEXT NOT NULL DEFAULT 'all',
    "key" TEXT NOT NULL DEFAULT 'all',
    "applications" INTEGER NOT NULL DEFAULT 0,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "responded" INTEGER NOT NULL DEFAULT 0,
    "screens" INTEGER NOT NULL DEFAULT 0,
    "interviews" INTEGER NOT NULL DEFAULT 0,
    "offers" INTEGER NOT NULL DEFAULT 0,
    "hires" INTEGER NOT NULL DEFAULT 0,
    "rejected" INTEGER NOT NULL DEFAULT 0,
    "withdrawn" INTEGER NOT NULL DEFAULT 0,
    "ghosted" INTEGER NOT NULL DEFAULT 0,
    "expired" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "sumMatchScore" INTEGER NOT NULL DEFAULT 0,
    "responseSamples" INTEGER NOT NULL DEFAULT 0,
    "sumResponseHrs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CandidateOutcomeMart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateMatchMart" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "matches" INTEGER NOT NULL DEFAULT 0,
    "sumMatchScore" INTEGER NOT NULL DEFAULT 0,
    "band0to49" INTEGER NOT NULL DEFAULT 0,
    "band50to69" INTEGER NOT NULL DEFAULT 0,
    "band70to84" INTEGER NOT NULL DEFAULT 0,
    "band85to100" INTEGER NOT NULL DEFAULT 0,
    "matchedKeywords" TEXT NOT NULL DEFAULT '[]',
    "missingKeywords" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CandidateMatchMart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateBenchmarkMart" (
    "id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "users" INTEGER NOT NULL DEFAULT 0,
    "applications" INTEGER NOT NULL DEFAULT 0,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "responded" INTEGER NOT NULL DEFAULT 0,
    "interviews" INTEGER NOT NULL DEFAULT 0,
    "offers" INTEGER NOT NULL DEFAULT 0,
    "hires" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CandidateBenchmarkMart_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CandidateOutcomeMart_userId_dimension_day_idx" ON "CandidateOutcomeMart"("userId", "dimension", "day");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateOutcomeMart_userId_day_dimension_key_key" ON "CandidateOutcomeMart"("userId", "day", "dimension", "key");

-- CreateIndex
CREATE INDEX "CandidateMatchMart_userId_day_idx" ON "CandidateMatchMart"("userId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateMatchMart_userId_day_key" ON "CandidateMatchMart"("userId", "day");

-- CreateIndex
CREATE INDEX "CandidateBenchmarkMart_dimension_key_day_idx" ON "CandidateBenchmarkMart"("dimension", "key", "day");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateBenchmarkMart_day_dimension_key_key" ON "CandidateBenchmarkMart"("day", "dimension", "key");

-- AddForeignKey
ALTER TABLE "CandidateOutcomeMart" ADD CONSTRAINT "CandidateOutcomeMart_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateMatchMart" ADD CONSTRAINT "CandidateMatchMart_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

