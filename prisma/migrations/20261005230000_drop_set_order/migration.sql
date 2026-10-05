-- The order of sets on Target Products, arranged by an admin. See DropSet. One new table;
-- nothing else changes. No rows to start with: every set shows as it did, newest first,
-- until the sets are first arranged.

-- CreateTable
CREATE TABLE "drop_sets" (
    "id" TEXT NOT NULL,
    "site_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "drop_sets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "drop_sets_site_key_name_key" ON "drop_sets"("site_key", "name");
