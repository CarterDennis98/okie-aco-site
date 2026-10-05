-- The order of products within a set on the drop page, arranged by an admin in the set
-- editor. See DropProduct.sortOrder. One new column; nothing else changes.

-- AlterTable
ALTER TABLE "drop_products" ADD COLUMN "sort_order" INTEGER NOT NULL DEFAULT 0;

-- Products already listed keep the order the page showed them in until now: by name,
-- within their set.
UPDATE "drop_products" AS d
   SET "sort_order" = r.n
  FROM (SELECT "id",
               ROW_NUMBER() OVER (PARTITION BY "site_key", "set_name" ORDER BY "name", "created_at") - 1 AS n
          FROM "drop_products") AS r
 WHERE d."id" = r."id";
