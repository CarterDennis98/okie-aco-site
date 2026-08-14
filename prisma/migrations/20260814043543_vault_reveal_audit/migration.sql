-- CreateTable
CREATE TABLE "vault_reveals" (
    "id" TEXT NOT NULL,
    "actor_discord_id" TEXT NOT NULL,
    "owner_discord_id" TEXT NOT NULL,
    "entity" "vault_entity" NOT NULL,
    "entity_id" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "on_behalf" BOOLEAN NOT NULL DEFAULT false,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vault_reveals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vault_reveals_at_idx" ON "vault_reveals"("at" DESC);

-- CreateIndex
CREATE INDEX "vault_reveals_owner_discord_id_idx" ON "vault_reveals"("owner_discord_id");
