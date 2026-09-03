-- Stage 13 review: when a candidate's analytics marts were last rebuilt for them, so the
-- analytics page rebuilds once on a first visit rather than on every visit. Additive, nullable.
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "analyticsBuiltAt" TIMESTAMP(3);

