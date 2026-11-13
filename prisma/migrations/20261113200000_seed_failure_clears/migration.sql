-- Edits members made before failed checkouts were recorded count as fixes too (2026-11-13).
--
-- vault_profiles.failures_cleared_at is set by every saved change from now on. Failures from
-- before today are being imported (okie-aco-mirror's backfillFailures.js, from 2026-11-01), and
-- without this a member who changed a profile's card on Nov 5 would see it flagged for its
-- declines on Nov 3. vault_changes holds every edit, so the last one becomes the line.
--
-- What counts is what counts live: a saved change to the profile, or an import over it. Not a
-- reorder, which only renumbers names (fields = {name}), and not an assignment, which moves no
-- detail. Never moves the line backwards, and does nothing on a database with no changes yet.
-- Data only; no schema change.

UPDATE "vault_profiles" AS p
SET "failures_cleared_at" = c."last_change"
FROM (
    SELECT "entity_id", MAX("at") AS "last_change"
    FROM "vault_changes"
    WHERE "entity" = 'VAULT_PROFILE'
      AND "action" = 'UPDATE'
      AND "fields" <> ARRAY['name']::TEXT[]
    GROUP BY "entity_id"
) AS c
WHERE p."id" = c."entity_id"
  AND (p."failures_cleared_at" IS NULL OR p."failures_cleared_at" < c."last_change");

-- And a failure already recorded from before its profile's last change stops counting, as one
-- arriving now would (CheckoutFailure.clearedAt). Nothing to do unless failures came in first.
UPDATE "checkout_failures" AS f
SET "cleared_at" = p."failures_cleared_at"
FROM "vault_profiles" AS p
WHERE f."vault_profile_id" = p."id"
  AND f."cleared_at" IS NULL
  AND p."failures_cleared_at" IS NOT NULL
  AND f."occurred_at" <= p."failures_cleared_at";
