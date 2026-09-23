-- Who each bill is owed to. Until now every bill was owed to whoever ran the billing run,
-- so that is exactly what existing rows are backfilled with.
ALTER TABLE "pas_bills" ADD COLUMN "payee_id" TEXT;

UPDATE "pas_bills" AS b
SET "payee_id" = r."operator_id"
FROM "pas_runs" AS r
WHERE b."pas_run_id" = r."id";

ALTER TABLE "pas_bills" ALTER COLUMN "payee_id" SET NOT NULL;

-- One member can now hold two bills in one run: one per person they owe.
DROP INDEX "pas_bills_pas_run_id_discord_user_id_key";

CREATE UNIQUE INDEX "pas_bills_pas_run_id_discord_user_id_payee_id_key" ON "pas_bills"("pas_run_id", "discord_user_id", "payee_id");

-- A payee's own view of what they are owed, and its badge.
CREATE INDEX "pas_bills_payee_id_paid_at_idx" ON "pas_bills"("payee_id", "paid_at");
