-- The PAS fee per unit Target Products shows beside a product's price. See
-- DropProduct.pasFeeCents. One new column; nothing else changes.

-- AlterTable
ALTER TABLE "drop_products" ADD COLUMN "pas_fee_cents" INTEGER;
