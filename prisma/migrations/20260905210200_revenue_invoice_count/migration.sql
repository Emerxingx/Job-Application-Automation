-- AlterTable
ALTER TABLE "DailyRevenueRollup" ADD COLUMN     "failedPaymentCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "invoicesBilled" INTEGER NOT NULL DEFAULT 0;

