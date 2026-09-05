-- Stage 19 review (M11): a placement is the agency's commercial record and
-- its invoice cites it. Deleting the candidate's account must not cascade
-- through Placement (and on to PlacementInvoice): the row is RESTRICTED, so
-- an account with a placement is scrubbed in place, never hard-deleted.
-- DropForeignKey
ALTER TABLE "Placement" DROP CONSTRAINT "Placement_candidateUserId_fkey";
-- AddForeignKey
ALTER TABLE "Placement" ADD CONSTRAINT "Placement_candidateUserId_fkey" FOREIGN KEY ("candidateUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
