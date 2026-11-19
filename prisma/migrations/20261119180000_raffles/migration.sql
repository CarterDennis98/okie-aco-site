-- Raffles (2026-11-19): Target's drawings, listed under "Live Raffles" on Target Products, and
-- each member's entry in them -- every profile, or the ones they pick. The Shikari export
-- builds a "Target Raffle <SKU>" task group per raffle from these. See Raffle, RaffleEntry and
-- RaffleEntryProfile. New tables only: nothing to backfill.

-- CreateTable
CREATE TABLE "raffles" (
    "id" TEXT NOT NULL,
    "site_key" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "image_url" TEXT,
    "price_cents" INTEGER,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "due_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "raffles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raffle_entries" (
    "id" TEXT NOT NULL,
    "raffle_id" TEXT NOT NULL,
    "discord_user_id" TEXT NOT NULL,
    "all_profiles" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "raffle_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raffle_entry_profiles" (
    "entry_id" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,

    CONSTRAINT "raffle_entry_profiles_pkey" PRIMARY KEY ("entry_id","profile_id")
);

-- CreateIndex
CREATE INDEX "raffles_site_key_due_at_idx" ON "raffles"("site_key", "due_at");

-- CreateIndex
CREATE UNIQUE INDEX "raffles_site_key_sku_key" ON "raffles"("site_key", "sku");

-- CreateIndex
CREATE INDEX "raffle_entries_discord_user_id_idx" ON "raffle_entries"("discord_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "raffle_entries_raffle_id_discord_user_id_key" ON "raffle_entries"("raffle_id", "discord_user_id");

-- CreateIndex
CREATE INDEX "raffle_entry_profiles_profile_id_idx" ON "raffle_entry_profiles"("profile_id");

-- AddForeignKey
ALTER TABLE "raffle_entries" ADD CONSTRAINT "raffle_entries_raffle_id_fkey" FOREIGN KEY ("raffle_id") REFERENCES "raffles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raffle_entries" ADD CONSTRAINT "raffle_entries_discord_user_id_fkey" FOREIGN KEY ("discord_user_id") REFERENCES "discord_members"("discord_user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raffle_entry_profiles" ADD CONSTRAINT "raffle_entry_profiles_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "raffle_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raffle_entry_profiles" ADD CONSTRAINT "raffle_entry_profiles_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "vault_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
