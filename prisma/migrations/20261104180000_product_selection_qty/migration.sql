-- A qty per pick on Target Products, for Shikari's per-product qty (2026-11-04): a pick's own
-- qty, and a profile's own where it differs. See ProductSelection.qty and ProductSelectionQty.
-- Nothing to backfill: NULL is the standard qty, which is what every checkout runs at today.

-- AlterTable
ALTER TABLE "product_selections" ADD COLUMN     "qty" INTEGER;

-- CreateTable
CREATE TABLE "product_selection_qtys" (
    "selection_id" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,

    CONSTRAINT "product_selection_qtys_pkey" PRIMARY KEY ("selection_id","profile_id")
);

-- CreateIndex
CREATE INDEX "product_selection_qtys_profile_id_idx" ON "product_selection_qtys"("profile_id");

-- AddForeignKey
ALTER TABLE "product_selection_qtys" ADD CONSTRAINT "product_selection_qtys_selection_id_fkey" FOREIGN KEY ("selection_id") REFERENCES "product_selections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_selection_qtys" ADD CONSTRAINT "product_selection_qtys_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "vault_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
