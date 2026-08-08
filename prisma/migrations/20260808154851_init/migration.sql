-- CreateEnum
CREATE TYPE "profile_status" AS ENUM ('MAPPED', 'UNMAPPED', 'IGNORED');

-- CreateEnum
CREATE TYPE "pas_run_status" AS ENUM ('DRAFT', 'PREVIEW', 'SENDING', 'SENT', 'ABORTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "delivery_status" AS ENUM ('PENDING', 'SENT', 'SKIPPED', 'DMS_CLOSED', 'UNKNOWN_USER', 'ERROR');

-- CreateEnum
CREATE TYPE "testimonial_source" AS ENUM ('MANUAL', 'DISCORD');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "email_verified" TIMESTAMP(3),
    "image" TEXT,
    "discord_user_id" TEXT,
    "hide_from_public_feed" BOOLEAN NOT NULL DEFAULT false,
    "first_login_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_account_id" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "session_token" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_tokens" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "discord_members" (
    "discord_user_id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "global_name" TEXT,
    "avatar_hash" TEXT,
    "roles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_og" BOOLEAN NOT NULL DEFAULT false,
    "joined_at" TIMESTAMP(3),
    "left_at" TIMESTAMP(3),
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discord_members_pkey" PRIMARY KEY ("discord_user_id")
);

-- CreateTable
CREATE TABLE "profiles" (
    "profile_key" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "discord_user_id" TEXT,
    "status" "profile_status" NOT NULL DEFAULT 'UNMAPPED',
    "note" TEXT,
    "mapped_by" TEXT,
    "mapped_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("profile_key")
);

-- CreateTable
CREATE TABLE "items" (
    "id" TEXT NOT NULL,
    "product_key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "source" TEXT,
    "sku" TEXT,
    "current_fee_cents" INTEGER,
    "unreadable" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_aliases" (
    "alias_key" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "item_aliases_pkey" PRIMARY KEY ("alias_key")
);

-- CreateTable
CREATE TABLE "checkouts" (
    "id" TEXT NOT NULL,
    "order_id" TEXT,
    "source_bot" TEXT NOT NULL,
    "discord_message_id" TEXT NOT NULL,
    "discord_channel_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "site" TEXT,
    "product_raw" TEXT,
    "product_key" TEXT NOT NULL,
    "item_id" TEXT,
    "profile_raw" TEXT,
    "profile_key" TEXT,
    "profile_index" INTEGER,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "quantity_assumed" BOOLEAN NOT NULL DEFAULT false,
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "raw_embed" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checkouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pas_runs" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "window_start" TIMESTAMP(3) NOT NULL,
    "window_end" TIMESTAMP(3) NOT NULL,
    "drop_label" TEXT NOT NULL,
    "status" "pas_run_status" NOT NULL DEFAULT 'DRAFT',
    "dry_run" BOOLEAN NOT NULL DEFAULT true,
    "operator_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),

    CONSTRAINT "pas_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pas_bills" (
    "id" TEXT NOT NULL,
    "pas_run_id" TEXT NOT NULL,
    "discord_user_id" TEXT NOT NULL,
    "subtotal_cents" INTEGER NOT NULL,
    "discount_cents" INTEGER NOT NULL DEFAULT 0,
    "total_cents" INTEGER NOT NULL,
    "og_applied" BOOLEAN NOT NULL DEFAULT false,
    "delivery_status" "delivery_status" NOT NULL DEFAULT 'PENDING',
    "delivery_error" TEXT,
    "dm_message_id" TEXT,
    "dm_text" TEXT,
    "paid_at" TIMESTAMP(3),
    "marked_paid_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pas_bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pas_bill_lines" (
    "id" TEXT NOT NULL,
    "pas_bill_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "fee_cents" INTEGER NOT NULL,
    "subtotal_cents" INTEGER NOT NULL,
    "label" TEXT NOT NULL,

    CONSTRAINT "pas_bill_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "pas_bill_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "method" TEXT,
    "note" TEXT,
    "recorded_by" TEXT NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "testimonials" (
    "id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "attribution" TEXT,
    "source" "testimonial_source" NOT NULL DEFAULT 'MANUAL',
    "source_message_id" TEXT,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "testimonials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_audit" (
    "id" TEXT NOT NULL,
    "actor_discord_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backfill_progress" (
    "channel_id" TEXT NOT NULL,
    "source_bot" TEXT NOT NULL,
    "last_message_id" TEXT,
    "messages_seen" INTEGER NOT NULL DEFAULT 0,
    "checkouts_ingested" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "backfill_progress_pkey" PRIMARY KEY ("channel_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_discord_user_id_key" ON "users"("discord_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_provider_provider_account_id_key" ON "accounts"("provider", "provider_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_session_token_key" ON "sessions"("session_token");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "verification_tokens_identifier_token_key" ON "verification_tokens"("identifier", "token");

-- CreateIndex
CREATE INDEX "discord_members_left_at_idx" ON "discord_members"("left_at");

-- CreateIndex
CREATE INDEX "profiles_discord_user_id_idx" ON "profiles"("discord_user_id");

-- CreateIndex
CREATE INDEX "profiles_status_idx" ON "profiles"("status");

-- CreateIndex
CREATE UNIQUE INDEX "items_product_key_key" ON "items"("product_key");

-- CreateIndex
CREATE INDEX "items_active_idx" ON "items"("active");

-- CreateIndex
CREATE UNIQUE INDEX "items_source_sku_key" ON "items"("source", "sku");

-- CreateIndex
CREATE INDEX "item_aliases_item_id_idx" ON "item_aliases"("item_id");

-- CreateIndex
CREATE UNIQUE INDEX "checkouts_discord_message_id_key" ON "checkouts"("discord_message_id");

-- CreateIndex
CREATE INDEX "checkouts_occurred_at_idx" ON "checkouts"("occurred_at" DESC);

-- CreateIndex
CREATE INDEX "checkouts_profile_key_idx" ON "checkouts"("profile_key");

-- CreateIndex
CREATE INDEX "checkouts_item_id_idx" ON "checkouts"("item_id");

-- CreateIndex
CREATE UNIQUE INDEX "checkouts_source_bot_order_id_key" ON "checkouts"("source_bot", "order_id");

-- CreateIndex
CREATE UNIQUE INDEX "pas_runs_session_id_key" ON "pas_runs"("session_id");

-- CreateIndex
CREATE INDEX "pas_runs_window_start_idx" ON "pas_runs"("window_start" DESC);

-- CreateIndex
CREATE INDEX "pas_bills_discord_user_id_paid_at_idx" ON "pas_bills"("discord_user_id", "paid_at");

-- CreateIndex
CREATE UNIQUE INDEX "pas_bills_pas_run_id_discord_user_id_key" ON "pas_bills"("pas_run_id", "discord_user_id");

-- CreateIndex
CREATE INDEX "pas_bill_lines_pas_bill_id_idx" ON "pas_bill_lines"("pas_bill_id");

-- CreateIndex
CREATE INDEX "pas_bill_lines_item_id_idx" ON "pas_bill_lines"("item_id");

-- CreateIndex
CREATE INDEX "payments_pas_bill_id_idx" ON "payments"("pas_bill_id");

-- CreateIndex
CREATE INDEX "testimonials_approved_sort_order_idx" ON "testimonials"("approved", "sort_order");

-- CreateIndex
CREATE INDEX "admin_audit_at_idx" ON "admin_audit"("at" DESC);

-- CreateIndex
CREATE INDEX "admin_audit_entity_entity_id_idx" ON "admin_audit"("entity", "entity_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_discord_user_id_fkey" FOREIGN KEY ("discord_user_id") REFERENCES "discord_members"("discord_user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_discord_user_id_fkey" FOREIGN KEY ("discord_user_id") REFERENCES "discord_members"("discord_user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_aliases" ADD CONSTRAINT "item_aliases_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_profile_key_fkey" FOREIGN KEY ("profile_key") REFERENCES "profiles"("profile_key") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pas_bills" ADD CONSTRAINT "pas_bills_pas_run_id_fkey" FOREIGN KEY ("pas_run_id") REFERENCES "pas_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pas_bills" ADD CONSTRAINT "pas_bills_discord_user_id_fkey" FOREIGN KEY ("discord_user_id") REFERENCES "discord_members"("discord_user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pas_bill_lines" ADD CONSTRAINT "pas_bill_lines_pas_bill_id_fkey" FOREIGN KEY ("pas_bill_id") REFERENCES "pas_bills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pas_bill_lines" ADD CONSTRAINT "pas_bill_lines_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_pas_bill_id_fkey" FOREIGN KEY ("pas_bill_id") REFERENCES "pas_bills"("id") ON DELETE CASCADE ON UPDATE CASCADE;
