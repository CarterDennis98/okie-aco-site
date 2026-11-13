-- The address book (2026-11-13): a member's own addresses and cards, kept once so a new profile
-- on any retailer can be filled from them. See SavedAddress and SavedCard. New tables only;
-- nothing existing changes, and nothing to backfill.

-- CreateTable
CREATE TABLE "saved_addresses" (
    "id" TEXT NOT NULL,
    "discord_user_id" TEXT NOT NULL,
    "label" TEXT,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "phone" TEXT,
    "ship_line1" TEXT NOT NULL,
    "ship_line2" TEXT,
    "ship_city" TEXT NOT NULL,
    "ship_state" TEXT NOT NULL,
    "ship_postal_code" TEXT NOT NULL,
    "ship_country" TEXT NOT NULL DEFAULT 'US',
    "same_billing_and_shipping" BOOLEAN NOT NULL DEFAULT true,
    "bill_first_name" TEXT,
    "bill_last_name" TEXT,
    "bill_line1" TEXT,
    "bill_line2" TEXT,
    "bill_city" TEXT,
    "bill_state" TEXT,
    "bill_postal_code" TEXT,
    "bill_country" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "saved_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_cards" (
    "id" TEXT NOT NULL,
    "discord_user_id" TEXT NOT NULL,
    "label" TEXT,
    "card_brand" TEXT NOT NULL,
    "card_last4" TEXT NOT NULL,
    "card_exp_month" TEXT NOT NULL,
    "card_exp_year" TEXT NOT NULL,
    "card_number_enc" TEXT NOT NULL,
    "card_cvv_enc" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "saved_cards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "saved_addresses_discord_user_id_idx" ON "saved_addresses"("discord_user_id");

-- CreateIndex
CREATE INDEX "saved_cards_discord_user_id_idx" ON "saved_cards"("discord_user_id");

-- AddForeignKey
ALTER TABLE "saved_addresses" ADD CONSTRAINT "saved_addresses_discord_user_id_fkey" FOREIGN KEY ("discord_user_id") REFERENCES "discord_members"("discord_user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_cards" ADD CONSTRAINT "saved_cards_discord_user_id_fkey" FOREIGN KEY ("discord_user_id") REFERENCES "discord_members"("discord_user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
