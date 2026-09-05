-- AlterTable
ALTER TABLE "DailyRevenueRollup" ADD COLUMN     "paymentsFailed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "paymentsPending" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "paymentsSucceeded" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "OrganizationDailyMart" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "dimension" TEXT NOT NULL DEFAULT 'all',
    "key" TEXT NOT NULL DEFAULT 'all',
    "valueInt" INTEGER NOT NULL DEFAULT 0,
    "valueCents" INTEGER NOT NULL DEFAULT 0,
    "people" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationDailyMart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionCohortMart" (
    "id" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "cohortMonth" TEXT NOT NULL,
    "monthOffset" INTEGER NOT NULL,
    "subscribers" INTEGER NOT NULL DEFAULT 0,
    "retained" INTEGER NOT NULL DEFAULT 0,
    "day" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionCohortMart_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrganizationDailyMart_organizationId_product_metric_day_idx" ON "OrganizationDailyMart"("organizationId", "product", "metric", "day");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationDailyMart_organizationId_day_product_metric_dim_key" ON "OrganizationDailyMart"("organizationId", "day", "product", "metric", "dimension", "key");

-- CreateIndex
CREATE INDEX "SubscriptionCohortMart_currency_cohortMonth_idx" ON "SubscriptionCohortMart"("currency", "cohortMonth");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionCohortMart_currency_cohortMonth_monthOffset_key" ON "SubscriptionCohortMart"("currency", "cohortMonth", "monthOffset");

-- AddForeignKey
ALTER TABLE "OrganizationDailyMart" ADD CONSTRAINT "OrganizationDailyMart_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

