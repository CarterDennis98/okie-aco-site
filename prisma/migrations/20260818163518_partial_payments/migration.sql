-- AlterTable
ALTER TABLE "pas_bills" ADD COLUMN     "paid_cents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "paid_claimed_cents" INTEGER;

-- Backfill paid_cents from the receipts that already exist.
--
-- IN THE SAME MIGRATION on purpose. Every bill in production is settled, so landing the
-- column at its default would leave 124 rows claiming paid_at IS NOT NULL while
-- paid_cents = 0 -- breaking the invariant the new balance math depends on, and reporting
-- the full amount as outstanding on every dashboard until a separate script caught up.
--
-- SUM, not total_cents: a bill that was confirmed, reopened, and confirmed again holds
-- +n, -n, +n and nets to what actually arrived. `payments` stays the source of truth;
-- this column is a running total of it.
UPDATE "pas_bills" b
SET "paid_cents" = COALESCE(
  (SELECT SUM(p."amount_cents") FROM "payments" p WHERE p."pas_bill_id" = b."id"),
  0
);
