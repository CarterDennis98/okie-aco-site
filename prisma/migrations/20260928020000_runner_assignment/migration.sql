-- Runners, and which one each profile is assigned to. See VaultAccount.assigneeId.

-- A move between runners is recorded as a pair of changes -- one for each bot it touches.
ALTER TYPE "vault_action" ADD VALUE 'ASSIGN';
ALTER TYPE "vault_action" ADD VALUE 'UNASSIGN';

-- Every login, and the profile behind it, gets a runner. Backfilled the way the work is
-- split today: chess runs Crunchyroll, and the operator runs everything else. Premium
-- Bandai is listed so the rule is written down in one place; nothing can have been saved
-- there before this ships.
ALTER TABLE "vault_accounts" ADD COLUMN "assignee_id" TEXT;

UPDATE "vault_accounts"
SET "assignee_id" = CASE "site_key"
  WHEN 'crunchyroll' THEN '397045810996576266'    -- chess
  WHEN 'premium-bandai' THEN '720050977444724868' -- peacemaker
  ELSE '235941044460584960'                       -- Logic, the operator
END;

ALTER TABLE "vault_accounts" ALTER COLUMN "assignee_id" SET NOT NULL;

CREATE INDEX "vault_accounts_site_key_assignee_id_idx" ON "vault_accounts"("site_key", "assignee_id");

-- Changes are stamped with the runner they have to reach. Existing ones follow the same
-- split, which is also exactly who holds each profile after the backfill above. Mailbox
-- changes carry no retailer and stay null: full admins only, as they always were.
ALTER TABLE "vault_changes" ADD COLUMN "assignee_id" TEXT;

UPDATE "vault_changes"
SET "assignee_id" = CASE "site_key"
  WHEN 'crunchyroll' THEN '397045810996576266'
  WHEN 'premium-bandai' THEN '720050977444724868'
  ELSE '235941044460584960'
END
WHERE "site_key" IS NOT NULL;

CREATE INDEX "vault_changes_assignee_id_applied_at_idx" ON "vault_changes"("assignee_id", "applied_at");

-- Fees issued by hand on the admin charges page, for a retailer /pas run can't see.
ALTER TABLE "pas_runs" ADD COLUMN "ad_hoc" BOOLEAN NOT NULL DEFAULT false;
