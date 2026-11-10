-- Target's per-checkout limit on a product, as an admin posts it on Target Products
-- (2026-11-09). See DropProduct.maxQty. Nothing to backfill: NULL is "no limit posted", which
-- is what every product has today -- and a product with none runs at the standard qty, as now.

-- AlterTable
ALTER TABLE "drop_products" ADD COLUMN     "max_qty" INTEGER;
