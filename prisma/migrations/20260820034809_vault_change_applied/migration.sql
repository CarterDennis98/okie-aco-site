-- AlterTable
ALTER TABLE "vault_changes" ADD COLUMN     "applied_at" TIMESTAMPTZ(3),
ADD COLUMN     "applied_by" TEXT;

-- CreateIndex
CREATE INDEX "vault_changes_owner_discord_id_applied_at_idx" ON "vault_changes"("owner_discord_id", "applied_at");

-- CreateIndex
CREATE INDEX "vault_changes_applied_at_at_idx" ON "vault_changes"("applied_at", "at" DESC);
