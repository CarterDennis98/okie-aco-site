-- A set's logo on Target Products. See DropSet.logoUrl. A set can now have a logo before it
-- has a place among the sets, so the place becomes optional: a row with no place is a set
-- that hasn't been placed yet, as no row was. Every existing row keeps its place.

-- AlterTable
ALTER TABLE "drop_sets" ADD COLUMN     "logo_url" TEXT,
ALTER COLUMN "sort_order" DROP NOT NULL;
