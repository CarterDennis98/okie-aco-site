-- Drop products and members' picks of them (replacing the ✅ reactions on the drops
-- channel), and the operator's saved Shikari instance setups. See DropProduct,
-- ProductSelection and ShikariInstance. New tables only; nothing existing changes.

-- CreateTable
CREATE TABLE "drop_products" (
    "id" TEXT NOT NULL,
    "site_key" TEXT NOT NULL,
    "set_name" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "price_cents" INTEGER,
    "image_url" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "drop_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_selections" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "discord_user_id" TEXT NOT NULL,
    "all_profiles" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_selections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_selection_profiles" (
    "selection_id" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,

    CONSTRAINT "product_selection_profiles_pkey" PRIMARY KEY ("selection_id","profile_id")
);

-- CreateTable
CREATE TABLE "shikari_instances" (
    "position" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "updated_by" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "shikari_instances_pkey" PRIMARY KEY ("position")
);

-- CreateIndex
CREATE INDEX "drop_products_site_key_active_idx" ON "drop_products"("site_key", "active");

-- CreateIndex
CREATE UNIQUE INDEX "drop_products_site_key_sku_key" ON "drop_products"("site_key", "sku");

-- CreateIndex
CREATE INDEX "product_selections_discord_user_id_idx" ON "product_selections"("discord_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_selections_product_id_discord_user_id_key" ON "product_selections"("product_id", "discord_user_id");

-- CreateIndex
CREATE INDEX "product_selection_profiles_profile_id_idx" ON "product_selection_profiles"("profile_id");

-- AddForeignKey
ALTER TABLE "product_selections" ADD CONSTRAINT "product_selections_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "drop_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_selections" ADD CONSTRAINT "product_selections_discord_user_id_fkey" FOREIGN KEY ("discord_user_id") REFERENCES "discord_members"("discord_user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_selection_profiles" ADD CONSTRAINT "product_selection_profiles_selection_id_fkey" FOREIGN KEY ("selection_id") REFERENCES "product_selections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_selection_profiles" ADD CONSTRAINT "product_selection_profiles_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "vault_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
