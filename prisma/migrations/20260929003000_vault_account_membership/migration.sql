-- Whether a retailer account carries a paid membership that retailer gates its drops behind:
-- Mattel's Red Line Club. See VaultAccount.hasMembership. Existing rows start false -- nothing
-- asked before, and on every retailer but Mattel the answer is no.
ALTER TABLE "vault_accounts" ADD COLUMN "has_membership" BOOLEAN NOT NULL DEFAULT false;
