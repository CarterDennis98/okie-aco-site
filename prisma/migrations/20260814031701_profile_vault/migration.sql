-- CreateEnum
CREATE TYPE "vault_entity" AS ENUM ('VAULT_PROFILE', 'VAULT_ACCOUNT', 'EMAIL_CREDENTIAL');

-- CreateEnum
CREATE TYPE "vault_action" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'ACTIVATE', 'DEACTIVATE');

-- CreateTable
CREATE TABLE "vault_accounts" (
    "id" TEXT NOT NULL,
    "site_key" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_enc" TEXT NOT NULL,
    "discord_user_id" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vault_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vault_profiles" (
    "id" TEXT NOT NULL,
    "site_key" TEXT NOT NULL,
    "discord_user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "profile_key" TEXT NOT NULL,
    "profile_index" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "account_id" TEXT NOT NULL,
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
    "card_brand" TEXT NOT NULL,
    "card_last4" TEXT NOT NULL,
    "card_exp_month" TEXT NOT NULL,
    "card_exp_year" TEXT NOT NULL,
    "card_number_enc" TEXT NOT NULL,
    "card_cvv_enc" TEXT NOT NULL,
    "only_checkout_once" BOOLEAN NOT NULL DEFAULT false,
    "match_name_on_card_and_address" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "vault_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_credentials" (
    "id" TEXT NOT NULL,
    "discord_user_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "app_password_enc" TEXT NOT NULL,
    "imap_host" TEXT,
    "imap_port" INTEGER,
    "verified_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "email_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vault_changes" (
    "id" TEXT NOT NULL,
    "actor_discord_id" TEXT NOT NULL,
    "owner_discord_id" TEXT NOT NULL,
    "entity" "vault_entity" NOT NULL,
    "entity_id" TEXT NOT NULL,
    "action" "vault_action" NOT NULL,
    "site_key" TEXT,
    "label" TEXT,
    "fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notified_at" TIMESTAMPTZ(3),

    CONSTRAINT "vault_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vault_exports" (
    "id" TEXT NOT NULL,
    "actor_discord_id" TEXT NOT NULL,
    "site_key" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "target_discord_id" TEXT,
    "profile_count" INTEGER NOT NULL,
    "account_count" INTEGER NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vault_exports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vault_accounts_discord_user_id_site_key_idx" ON "vault_accounts"("discord_user_id", "site_key");

-- CreateIndex
CREATE UNIQUE INDEX "vault_accounts_site_key_email_key" ON "vault_accounts"("site_key", "email");

-- CreateIndex
CREATE UNIQUE INDEX "vault_profiles_account_id_key" ON "vault_profiles"("account_id");

-- CreateIndex
CREATE INDEX "vault_profiles_discord_user_id_site_key_idx" ON "vault_profiles"("discord_user_id", "site_key");

-- CreateIndex
CREATE INDEX "vault_profiles_profile_key_idx" ON "vault_profiles"("profile_key");

-- CreateIndex
CREATE INDEX "vault_profiles_site_key_active_idx" ON "vault_profiles"("site_key", "active");

-- CreateIndex
CREATE UNIQUE INDEX "vault_profiles_site_key_name_key" ON "vault_profiles"("site_key", "name");

-- CreateIndex
CREATE UNIQUE INDEX "email_credentials_email_key" ON "email_credentials"("email");

-- CreateIndex
CREATE INDEX "email_credentials_discord_user_id_idx" ON "email_credentials"("discord_user_id");

-- CreateIndex
CREATE INDEX "vault_changes_at_idx" ON "vault_changes"("at" DESC);

-- CreateIndex
CREATE INDEX "vault_changes_owner_discord_id_idx" ON "vault_changes"("owner_discord_id");

-- CreateIndex
CREATE INDEX "vault_changes_notified_at_idx" ON "vault_changes"("notified_at");

-- CreateIndex
CREATE INDEX "vault_exports_at_idx" ON "vault_exports"("at" DESC);

-- AddForeignKey
ALTER TABLE "vault_accounts" ADD CONSTRAINT "vault_accounts_discord_user_id_fkey" FOREIGN KEY ("discord_user_id") REFERENCES "discord_members"("discord_user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vault_profiles" ADD CONSTRAINT "vault_profiles_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "vault_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vault_profiles" ADD CONSTRAINT "vault_profiles_discord_user_id_fkey" FOREIGN KEY ("discord_user_id") REFERENCES "discord_members"("discord_user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_credentials" ADD CONSTRAINT "email_credentials_discord_user_id_fkey" FOREIGN KEY ("discord_user_id") REFERENCES "discord_members"("discord_user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
