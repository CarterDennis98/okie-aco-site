-- Clean slate at go-live: nothing that already exists is "pending".
--
-- WHY A SECOND SWEEP. The earlier backfill ran when its migration was applied, which in
-- production was BEFORE the code that shows this state ships. Any edit a member made in the
-- gap between those two moments has applied_at IS NULL, so the day the feature goes live it
-- would greet them with a "pending confirmation" tag on a change from days ago that has long
-- since been loaded onto the bots. Running the same sweep again immediately before the
-- deploy closes that window.
--
-- Idempotent by construction -- it only touches rows that are still NULL -- so applying it
-- on a database that has nothing outstanding is a no-op, and re-running it is harmless.
--
-- NOT a substitute for the tick logic. Most profiles have no vault_changes row at all (1,268
-- of 1,287 came in through the AYCD import), so nothing here can mark them confirmed; the
-- member's page treats "no pending edit" as up to date rather than requiring a change row.
-- See loadProfileChangeState and the tick in profile-manager.tsx.
--
-- After this, the only pending rows are edits made once the feature was actually live, which
-- is exactly what the operator's queue should contain.
UPDATE "vault_changes"
SET "applied_at" = "at",
    "applied_by" = 'backfill'
WHERE "applied_at" IS NULL;
