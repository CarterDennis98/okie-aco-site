-- AlterTable
ALTER TABLE "pas_bills" ADD COLUMN     "paid_claimed_at" TIMESTAMPTZ(3),
ADD COLUMN     "paid_claimed_method" TEXT,
ADD COLUMN     "paid_claimed_note" TEXT;

-- CreateIndex
CREATE INDEX "pas_bills_paid_at_paid_claimed_at_idx" ON "pas_bills"("paid_at", "paid_claimed_at");
