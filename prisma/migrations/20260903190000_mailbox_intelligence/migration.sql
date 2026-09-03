-- CreateTable
CREATE TABLE "MailboxConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "accountEmail" TEXT NOT NULL,
    "scopes" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'connected',
    "consentId" TEXT,
    "cursor" TEXT,
    "errorCode" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "MailboxConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailboxSecret" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailboxSecret_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailThread" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "providerThreadId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "participants" TEXT NOT NULL DEFAULT '[]',
    "fromAddress" TEXT NOT NULL,
    "lastMessageAt" TIMESTAMP(3) NOT NULL,
    "hasCalendarInvite" BOOLEAN NOT NULL DEFAULT false,
    "applicationId" TEXT,
    "rivalApplicationId" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "associationStatus" TEXT NOT NULL DEFAULT 'none',
    "associatedBy" TEXT,
    "signals" TEXT NOT NULL DEFAULT '[]',
    "interviewDetected" BOOLEAN NOT NULL DEFAULT false,
    "offerDetected" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailMessageRef" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "providerMessageId" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "direction" TEXT NOT NULL,

    CONSTRAINT "EmailMessageRef_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarEventRef" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "organiser" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "attendees" TEXT NOT NULL DEFAULT '[]',
    "applicationId" TEXT,
    "interviewId" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "associationStatus" TEXT NOT NULL DEFAULT 'none',
    "signals" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarEventRef_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectionId" TEXT,
    "type" TEXT NOT NULL,
    "threadId" TEXT,
    "applicationId" TEXT,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "handledAt" TIMESTAMP(3),

    CONSTRAINT "IntegrationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MailboxConnection_userId_idx" ON "MailboxConnection"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "MailboxConnection_userId_provider_kind_accountEmail_key" ON "MailboxConnection"("userId", "provider", "kind", "accountEmail");

-- CreateIndex
CREATE UNIQUE INDEX "MailboxSecret_connectionId_key" ON "MailboxSecret"("connectionId");

-- CreateIndex
CREATE INDEX "EmailThread_userId_applicationId_idx" ON "EmailThread"("userId", "applicationId");

-- CreateIndex
CREATE INDEX "EmailThread_userId_associationStatus_lastMessageAt_idx" ON "EmailThread"("userId", "associationStatus", "lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailThread_connectionId_providerThreadId_key" ON "EmailThread"("connectionId", "providerThreadId");

-- CreateIndex
CREATE INDEX "EmailMessageRef_userId_sentAt_idx" ON "EmailMessageRef"("userId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailMessageRef_threadId_providerMessageId_key" ON "EmailMessageRef"("threadId", "providerMessageId");

-- CreateIndex
CREATE INDEX "CalendarEventRef_userId_startsAt_idx" ON "CalendarEventRef"("userId", "startsAt");

-- CreateIndex
CREATE INDEX "CalendarEventRef_userId_applicationId_idx" ON "CalendarEventRef"("userId", "applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarEventRef_connectionId_providerEventId_key" ON "CalendarEventRef"("connectionId", "providerEventId");

-- CreateIndex
CREATE INDEX "IntegrationEvent_userId_createdAt_idx" ON "IntegrationEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "IntegrationEvent_type_handledAt_idx" ON "IntegrationEvent"("type", "handledAt");

-- CreateIndex
CREATE INDEX "IntegrationEvent_connectionId_idx" ON "IntegrationEvent"("connectionId");

-- AddForeignKey
ALTER TABLE "MailboxConnection" ADD CONSTRAINT "MailboxConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailboxSecret" ADD CONSTRAINT "MailboxSecret_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "MailboxConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailThread" ADD CONSTRAINT "EmailThread_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailThread" ADD CONSTRAINT "EmailThread_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "MailboxConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailThread" ADD CONSTRAINT "EmailThread_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessageRef" ADD CONSTRAINT "EmailMessageRef_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessageRef" ADD CONSTRAINT "EmailMessageRef_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "EmailThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarEventRef" ADD CONSTRAINT "CalendarEventRef_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarEventRef" ADD CONSTRAINT "CalendarEventRef_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "MailboxConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarEventRef" ADD CONSTRAINT "CalendarEventRef_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarEventRef" ADD CONSTRAINT "CalendarEventRef_interviewId_fkey" FOREIGN KEY ("interviewId") REFERENCES "ApplicationInterview"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationEvent" ADD CONSTRAINT "IntegrationEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

