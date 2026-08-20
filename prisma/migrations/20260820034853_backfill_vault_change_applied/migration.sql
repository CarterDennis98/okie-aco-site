-- Treat every change recorded BEFORE applied_at existed as already applied.
--
-- Without this, adding the column makes the entire history pending: every member is told
-- their week-old card update still hasn't reached the bot, and the operator's new queue
-- opens with hundreds of rows that were exported and loaded long ago. Both are wrong, and
-- the wrongness is loud -- it lands on the member's dashboard.
--
-- `at` is used as the applied timestamp rather than now(). We genuinely do not know when
-- each of these went live, and stamping them all with the deploy time would invent a
-- precise-looking answer; stamping them with when the change was made at least keeps the
-- ordering truthful and never claims a change was applied before it was made.
--
-- applied_by = 'backfill' rather than NULL so these stay distinguishable from an operator's
-- deliberate mark forever. A NULL there would be indistinguishable from a bug that set the
-- timestamp without recording who.
--
-- Scoped to rows that exist NOW. Anything written after this migration runs is a real
-- change with a real pending state, and must not be swept up.
UPDATE "vault_changes"
SET "applied_at" = "at",
    "applied_by" = 'backfill'
WHERE "applied_at" IS NULL;
