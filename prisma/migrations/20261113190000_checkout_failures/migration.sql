-- Failed checkouts (2026-11-13): every decline, cancelled order and checkout error the mirror
-- posts, matched to the profile it ran on so that profile can be flagged. See CheckoutFailure
-- and VaultProfile.failuresClearedAt. Nothing to backfill: flags start from the first failure
-- the bot sends after this ships, and NULL on every existing profile means "never changed",
-- which is what they all are as far as failures go.

-- AlterTable
ALTER TABLE "vault_profiles" ADD COLUMN     "failures_cleared_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "checkout_failures" (
    "id" TEXT NOT NULL,
    "source_bot" TEXT NOT NULL,
    "discord_message_id" TEXT NOT NULL,
    "discord_channel_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "site" TEXT,
    "site_key" TEXT,
    "order_id" TEXT,
    "product_raw" TEXT,
    "profile_raw" TEXT,
    "reason" TEXT,
    "vault_profile_id" TEXT,
    "cleared_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checkout_failures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "checkout_failures_discord_message_id_key" ON "checkout_failures"("discord_message_id");

-- CreateIndex
CREATE INDEX "checkout_failures_vault_profile_id_cleared_at_idx" ON "checkout_failures"("vault_profile_id", "cleared_at");

-- CreateIndex
CREATE INDEX "checkout_failures_occurred_at_idx" ON "checkout_failures"("occurred_at" DESC);

-- AddForeignKey
ALTER TABLE "checkout_failures" ADD CONSTRAINT "checkout_failures_vault_profile_id_fkey" FOREIGN KEY ("vault_profile_id") REFERENCES "vault_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
