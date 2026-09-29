-- ACO credit: money the operator gives a member that comes off their next fees. See AcoCredit
-- and PasBill.creditCents. Every existing bill spent none.

-- AlterTable
ALTER TABLE "pas_bills" ADD COLUMN     "credit_cents" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "aco_credits" (
    "id" TEXT NOT NULL,
    "discord_user_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "note" TEXT,
    "issued_by" TEXT NOT NULL,
    "request_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "aco_credits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "aco_credits_request_key_key" ON "aco_credits"("request_key");

-- CreateIndex
CREATE INDEX "aco_credits_discord_user_id_created_at_idx" ON "aco_credits"("discord_user_id", "created_at");

-- AddForeignKey
ALTER TABLE "aco_credits" ADD CONSTRAINT "aco_credits_discord_user_id_fkey" FOREIGN KEY ("discord_user_id") REFERENCES "discord_members"("discord_user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
