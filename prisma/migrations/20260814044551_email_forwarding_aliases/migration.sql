-- AlterEnum
ALTER TYPE "vault_entity" ADD VALUE 'EMAIL_ALIAS';

-- CreateTable
CREATE TABLE "email_aliases" (
    "id" TEXT NOT NULL,
    "discord_user_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "credential_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "email_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_aliases_email_key" ON "email_aliases"("email");

-- CreateIndex
CREATE INDEX "email_aliases_discord_user_id_idx" ON "email_aliases"("discord_user_id");

-- CreateIndex
CREATE INDEX "email_aliases_credential_id_idx" ON "email_aliases"("credential_id");

-- AddForeignKey
ALTER TABLE "email_aliases" ADD CONSTRAINT "email_aliases_discord_user_id_fkey" FOREIGN KEY ("discord_user_id") REFERENCES "discord_members"("discord_user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_aliases" ADD CONSTRAINT "email_aliases_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "email_credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;
