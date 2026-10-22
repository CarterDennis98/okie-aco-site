-- Product lines on Target Products -- Pokémon, Topps, One Piece -- that sets are listed under.
-- See DropLine. One new table, and a set's line on its DropSet row. No rows to start with:
-- every set shows as it did until it's put in a line.

-- AlterTable
ALTER TABLE "drop_sets" ADD COLUMN     "line_id" TEXT;

-- CreateTable
CREATE TABLE "drop_lines" (
    "id" TEXT NOT NULL,
    "site_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logo_url" TEXT,
    "sort_order" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "drop_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "drop_lines_site_key_name_key" ON "drop_lines"("site_key", "name");

-- CreateIndex
CREATE INDEX "drop_sets_line_id_idx" ON "drop_sets"("line_id");

-- AddForeignKey
ALTER TABLE "drop_sets" ADD CONSTRAINT "drop_sets_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "drop_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;
