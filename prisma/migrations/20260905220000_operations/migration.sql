-- CreateTable
CREATE TABLE "RateLimitBucket" (
    "id" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "resetAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerRun" (
    "id" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "workerId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,
    "summary" TEXT,

    CONSTRAINT "WorkerRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RateLimitBucket_resetAt_idx" ON "RateLimitBucket"("resetAt");

-- CreateIndex
CREATE INDEX "WorkerRun_job_status_startedAt_idx" ON "WorkerRun"("job", "status", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerRun_job_windowStart_key" ON "WorkerRun"("job", "windowStart");

