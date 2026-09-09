import "server-only";

import { prisma } from "@/db/client";
import { VaultEntity } from "@/generated/prisma/enums";
import { loginOnlySiteKeys, siteStyle } from "@/lib/sites";
import { loadMailboxCoverage, mailboxFor, type MailboxCoverage } from "@/db/queries/email-coverage";
import { cardSignature, isExpired, maskedLabel } from "@/lib/vault/card";
import { nextProfileName, profileBaseFor } from "@/lib/vault/profile-input";

/**
 * Member-scoped reads for the profile manager.
 *
 * **Nothing here decrypts.** Every field returned is a clear column -- brand, last 4,
 * expiry, email, address. The `*_enc` columns are not selected at all, so no page that
 * renders this data can leak a secret even by accident. Decryption happens in exactly
 * one place: the audited export.
 *
 * Same ownership rule as the rest of the dashboard: `discordUserId` is a required first
 * argument, sourced only from `requireMember()`, and every lookup by id carries both
 * predicates so a guessed id is indistinguishable from a missing one.
 */

export type VaultProfileSummary = {
  id: string;
  siteKey: string;
  name: string;
  active: boolean;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  cardBrand: string;
  cardLast4: string;
  cardExpMonth: string;
  cardExpYear: string;
  cardLabel: string;
  cardExpired: boolean;
  /**
   * Other profiles of theirs ON THE SAME RETAILER that appear to use this same card.
   * Advisory: retailers are more likely to fail orders that reuse a card, so the member
   * is told rather than stopped. Empty for all but the duplicates themselves.
   */
  sharesCardWith: string[];
  shipCity: string;
  shipState: string;
  sameBillingAndShipping: boolean;
  // The mailbox this profile's verification codes land in: the account email itself when
  // it holds an app password, a different address when it forwards into one, null when
  // nothing covers it. The password is never carried here -- the reveal action fetches
  // it, and audits the read.
  mailbox: string | null;
  /**
   * When this profile's oldest unconfirmed edit was made, or null when nothing is waiting.
   *
   * The member's half of the pair on `VaultChange.appliedAt`. An edit saved here isn't in
   * use until the operator confirms it, and before this existed the page gave no way to
   * tell -- a member who changed a card an hour before a drop had no idea whether the drop
   * would use the new one.
   */
  pendingSince: Date | null;
  /**
   * When this profile's most recent change was confirmed, or null if it never has been.
   *
   * Drives the green tick. Deliberately separate from `pendingSince` rather than one
   * three-state field: a profile can have a confirmed history AND a fresh edit waiting, and
   * the two facts are both worth showing.
   */
  confirmedAt: Date | null;
  updatedAt: Date;
};

export type VaultProfileDetail = VaultProfileSummary & {
  accountId: string;
  shipLine1: string;
  shipLine2: string | null;
  shipPostalCode: string;
  shipCountry: string;
  billFirstName: string | null;
  billLastName: string | null;
  billLine1: string | null;
  billLine2: string | null;
  billCity: string | null;
  billState: string | null;
  billPostalCode: string | null;
  billCountry: string | null;
  matchNameOnCardAndAddress: boolean;
  onlyCheckoutOnce: boolean;
};

/**
 * One retailer login, on a site where that is all we hold.
 *
 * A `vault_account` with no `vault_profile` behind it -- see `usesProfiles` in sites.ts.
 * There is no name, no card and no address here because none of those exist for Costco:
 * the order is placed by hand from the member's own account, so the credentials are the
 * whole record.
 *
 * Carries the same `mailbox` / `pendingSince` / `confirmedAt` trio a profile does, and for
 * the same reasons -- a member needs to know where a verification code lands and whether
 * the login they just changed has reached us yet.
 */
export type VaultLoginSummary = {
  id: string;
  siteKey: string;
  email: string;
  active: boolean;
  /** The mailbox this login's verification codes land in, or null when nothing covers it. */
  mailbox: string | null;
  /**
   * Whether a security code is stored, on a retailer that asks for one.
   *
   * WHETHER, not what. Derived from `card_cvv_enc IS NULL` in the database -- the
   * ciphertext is never selected, matching the rule at the top of this file, and a CVV is
   * not revealable even to its owner (see reveal.ts on why app passwords are the only
   * exception). The member needs to know one is on file so they can tell a blank field
   * meaning "keep it" from a blank field meaning "there is none".
   *
   * Always false on a retailer that stores none, which is what `storesCardCvv` is for --
   * do not read this as "missing" without checking that first.
   */
  hasCvv: boolean;
  pendingSince: Date | null;
  confirmedAt: Date | null;
  updatedAt: Date;
};

export type EmailCredentialSummary = {
  id: string;
  email: string;
  verifiedAt: Date | null;
  lastError: string | null;
  /** When a check last ran, pass or fail. Null means nobody has ever tested it. */
  lastCheckedAt: Date | null;
  updatedAt: Date;
  /** Addresses that forward into this mailbox, so one password covers all of them. */
  aliases: { id: string; email: string }[];
  /**
   * When this mailbox's oldest unconfirmed change was made, or null when nothing is waiting.
   *
   * Same meaning as on a profile: a new app password is no use until it is on the bot, and
   * that is not something the member can see for themselves.
   */
  pendingSince: Date | null;
  /** When its most recent change was confirmed. Null when it has no change history. */
  confirmedAt: Date | null;
};

const SUMMARY_SELECT = {
  id: true,
  siteKey: true,
  name: true,
  active: true,
  firstName: true,
  lastName: true,
  phone: true,
  cardBrand: true,
  cardLast4: true,
  cardExpMonth: true,
  cardExpYear: true,
  shipCity: true,
  shipState: true,
  sameBillingAndShipping: true,
  updatedAt: true,
  account: { select: { email: true } },
} as const;

type SummaryRow = {
  id: string;
  siteKey: string;
  name: string;
  active: boolean;
  firstName: string;
  lastName: string;
  phone: string | null;
  cardBrand: string;
  cardLast4: string;
  cardExpMonth: string;
  cardExpYear: string;
  shipCity: string;
  shipState: string;
  sameBillingAndShipping: boolean;
  updatedAt: Date;
  account: { email: string };
};

function toSummary(
  row: SummaryRow,
  coverage?: MailboxCoverage,
  changes?: ChangeState,
): VaultProfileSummary {
  return {
    // Filled in per retailer by whoever assembles the groups; a lone profile shares
    // nothing with anyone.
    sharesCardWith: [],
    pendingSince: changes?.pending.get(row.id) ?? null,
    confirmedAt: changes?.confirmed.get(row.id) ?? null,
    id: row.id,
    siteKey: row.siteKey,
    name: row.name,
    active: row.active,
    email: row.account.email,
    firstName: row.firstName,
    lastName: row.lastName,
    phone: row.phone,
    cardBrand: row.cardBrand,
    cardLast4: row.cardLast4,
    cardExpMonth: row.cardExpMonth,
    cardExpYear: row.cardExpYear,
    cardLabel: maskedLabel(row.cardBrand, row.cardLast4),
    cardExpired: isExpired(row.cardExpMonth, row.cardExpYear),
    shipCity: row.shipCity,
    shipState: row.shipState,
    sameBillingAndShipping: row.sameBillingAndShipping,
    mailbox: coverage ? mailboxFor(coverage, row.account.email) : null,
    updatedAt: row.updatedAt,
  };
}

/**
 * Every profile a member owns, grouped by retailer.
 *
 * Sorted with the natural profile order ("carter - 2" after "carter - 10" would read
 * as a bug), so the numeric suffix is compared as a number.
 */
export async function getMemberProfiles(
  discordUserId: string,
): Promise<{ siteKey: string; profiles: VaultProfileSummary[] }[]> {
  const [rows, coverage, changes] = await Promise.all([
    prisma.vaultProfile.findMany({ where: { discordUserId }, select: SUMMARY_SELECT }),
    loadMailboxCoverage(discordUserId),
    loadChangeState(discordUserId),
  ]);

  const bySite = new Map<string, VaultProfileSummary[]>();
  for (const row of rows) {
    const list = bySite.get(row.siteKey) ?? [];
    list.push(toSummary(row, coverage, changes));
    bySite.set(row.siteKey, list);
  }

  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  for (const list of bySite.values()) {
    list.sort((a, b) => collator.compare(a.name, b.name));
    markSharedCards(list);
  }

  return [...bySite.entries()]
    .map(([siteKey, profiles]) => ({ siteKey, profiles }))
    .sort((a, b) => a.siteKey.localeCompare(b.siteKey));
}

type ChangeState = {
  /** Row id -> when its OLDEST unconfirmed edit was made. */
  pending: Map<string, Date>;
  /** Row id -> when its MOST RECENT confirmed change was confirmed. */
  confirmed: Map<string, Date>;
};

/**
 * Per-row confirmation state for one entity, in one query.
 *
 * Keyed on `entityId`, which for a VAULT_PROFILE change is the profile's own id and for a
 * VAULT_ACCOUNT change the login's. One entity at a time: a mailbox edit is real but it
 * isn't something a profile row can sensibly display, and a login and the profile in front
 * of it are separate rows with separate histories.
 *
 * The two maps take opposite ends of the ordering on purpose. Pending wants the oldest --
 * "waiting since 9am" is the useful sentence, not "since 4pm". Confirmed wants the newest,
 * because the tick should say when this profile was last signed off, not when it was
 * created.
 *
 * A DELETE leaves a row pointing at an id that no longer exists, which is harmless -- the
 * lookup simply never matches -- and deliberately not cleaned up, because the audit trail
 * outliving the row it describes is the entire point of an append-only log.
 */
async function loadChangeState(
  discordUserId: string,
  entity: VaultEntity = VaultEntity.VAULT_PROFILE,
): Promise<ChangeState> {
  const rows = await prisma.vaultChange.findMany({
    where: { ownerDiscordId: discordUserId, entity },
    orderBy: { at: "asc" },
    select: { entityId: true, at: true, appliedAt: true },
  });

  const pending = new Map<string, Date>();
  const confirmed = new Map<string, Date>();
  for (const row of rows) {
    if (row.appliedAt === null) {
      // First write wins, and the rows arrive oldest-first, so this keeps the oldest.
      if (!pending.has(row.entityId)) pending.set(row.entityId, row.at);
    } else {
      // Last write wins, for the same reason in reverse.
      confirmed.set(row.entityId, row.appliedAt);
    }
  }
  return { pending, confirmed };
}

/**
 * Flag profiles on one retailer that look like they share a card.
 *
 * Per retailer on purpose: the same card on Target and on Walmart is normal and not worth
 * mentioning. Two profiles on the SAME retailer paying with one card is what raises the
 * chance of a decline.
 */
function markSharedCards(list: VaultProfileSummary[]): void {
  const bySignature = new Map<string, string[]>();
  for (const profile of list) {
    const signature = cardSignature(profile);
    if (!signature) continue;
    bySignature.set(signature, [...(bySignature.get(signature) ?? []), profile.name]);
  }
  for (const profile of list) {
    const signature = cardSignature(profile);
    const sharing = signature ? (bySignature.get(signature) ?? []) : [];
    profile.sharesCardWith = sharing.filter((name) => name !== profile.name);
  }
}

/** One profile, in full, for the edit form. Null when it isn't theirs. */
export async function getMemberProfile(
  discordUserId: string,
  profileId: string,
): Promise<VaultProfileDetail | null> {
  const row = await prisma.vaultProfile.findFirst({
    // Both predicates, never fetch-then-compare.
    where: { id: profileId, discordUserId },
    select: {
      ...SUMMARY_SELECT,
      accountId: true,
      shipLine1: true,
      shipLine2: true,
      shipPostalCode: true,
      shipCountry: true,
      billFirstName: true,
      billLastName: true,
      billLine1: true,
      billLine2: true,
      billCity: true,
      billState: true,
      billPostalCode: true,
      billCountry: true,
      matchNameOnCardAndAddress: true,
      onlyCheckoutOnce: true,
    },
  });
  if (!row) return null;

  // Resolved here rather than left null: a detail row that silently disagreed with the
  // summary about coverage -- or about whether an edit is still waiting -- would be a trap
  // for the next caller.
  const [coverage, changes] = await Promise.all([
    loadMailboxCoverage(discordUserId),
    loadChangeState(discordUserId),
  ]);

  return {
    ...toSummary(row, coverage, changes),
    accountId: row.accountId,
    shipLine1: row.shipLine1,
    shipLine2: row.shipLine2,
    shipPostalCode: row.shipPostalCode,
    shipCountry: row.shipCountry,
    billFirstName: row.billFirstName,
    billLastName: row.billLastName,
    billLine1: row.billLine1,
    billLine2: row.billLine2,
    billCity: row.billCity,
    billState: row.billState,
    billPostalCode: row.billPostalCode,
    billCountry: row.billCountry,
    matchNameOnCardAndAddress: row.matchNameOnCardAndAddress,
    onlyCheckoutOnce: row.onlyCheckoutOnce,
  };
}

/**
 * A member's retailer logins on the sites where a login is all we hold, by retailer.
 *
 * ONLY login-only retailers. Every other site's accounts are reachable through the
 * profile that owns them, and listing them here as well would show a member the same
 * Target credential twice -- in a list that offers no card and no address to go with it.
 *
 * `password_enc` is not selected, like every other read in this file. Nothing shows a
 * retailer password back, not even to its owner: unlike an app password there is no
 * inbox to open with it, so a reveal would be a leak with no use behind it.
 */
export async function getMemberLogins(
  discordUserId: string,
): Promise<{ siteKey: string; logins: VaultLoginSummary[] }[]> {
  const siteKeys = loginOnlySiteKeys();
  if (siteKeys.length === 0) return [];

  const [rows, withoutCvv, coverage, changes] = await Promise.all([
    prisma.vaultAccount.findMany({
      where: { discordUserId, siteKey: { in: siteKeys } },
      orderBy: { email: "asc" },
      select: { id: true, siteKey: true, email: true, active: true, updatedAt: true },
    }),
    // A filter on NULL rather than a projection: this is how "is a code on file" gets
    // answered without the ciphertext ever leaving the database. Same trick as
    // `getMemberLoginsForAdmin`'s passwordless set.
    prisma.vaultAccount.findMany({
      where: { discordUserId, siteKey: { in: siteKeys }, cardCvvEnc: null },
      select: { id: true },
    }),
    loadMailboxCoverage(discordUserId),
    loadChangeState(discordUserId, VaultEntity.VAULT_ACCOUNT),
  ]);

  const missingCvv = new Set(withoutCvv.map((row) => row.id));

  const bySite = new Map<string, VaultLoginSummary[]>();
  for (const row of rows) {
    const list = bySite.get(row.siteKey) ?? [];
    list.push({
      id: row.id,
      siteKey: row.siteKey,
      email: row.email,
      active: row.active,
      mailbox: mailboxFor(coverage, row.email),
      hasCvv: !missingCvv.has(row.id),
      pendingSince: changes.pending.get(row.id) ?? null,
      confirmedAt: changes.confirmed.get(row.id) ?? null,
      updatedAt: row.updatedAt,
    });
    bySite.set(row.siteKey, list);
  }

  return [...bySite.entries()]
    .map(([siteKey, logins]) => ({ siteKey, logins }))
    .sort((a, b) => a.siteKey.localeCompare(b.siteKey));
}

/**
 * Email app passwords.
 *
 * The password itself is never selected -- only whether one exists, and whether it last
 * worked. `hasPassword` is derived from a non-empty ciphertext rather than returning it.
 *
 * Carries the same confirmation state as a profile. A new app password has to reach the bot
 * exactly like a new card does, so "is this live yet" is the same question and deserves the
 * same answer -- the operator's queue already listed these changes under "Email"; only the
 * member's side was silent.
 *
 * FORWARDING CHANGES COUNT TOO, and are attributed to the mailbox they point at: an alias
 * only means anything relative to the inbox it routes into, so "this address now forwards
 * here" is a pending change to THAT mailbox's coverage. A change to an alias that has since
 * been deleted cannot be mapped back to a credential and is not shown here; it stays visible
 * in the operator's queue, which is where an already-undone change belongs.
 */
export async function getMemberEmailCredentials(
  discordUserId: string,
): Promise<EmailCredentialSummary[]> {
  const [rows, changes] = await Promise.all([
    prisma.emailCredential.findMany({
      where: { discordUserId },
      orderBy: { email: "asc" },
      select: {
        id: true,
        email: true,
        verifiedAt: true,
        lastError: true,
        lastCheckedAt: true,
        updatedAt: true,
        aliases: { select: { id: true, email: true }, orderBy: { email: "asc" } },
      },
    }),
    prisma.vaultChange.findMany({
      where: {
        ownerDiscordId: discordUserId,
        entity: { in: [VaultEntity.EMAIL_CREDENTIAL, VaultEntity.EMAIL_ALIAS] },
      },
      orderBy: { at: "asc" },
      select: { entity: true, entityId: true, at: true, appliedAt: true },
    }),
  ]);

  // Alias id -> the credential it routes into, so an alias change lands on the right row.
  const credentialByAlias = new Map<string, string>();
  for (const row of rows) for (const alias of row.aliases) credentialByAlias.set(alias.id, row.id);

  const pending = new Map<string, Date>();
  const confirmed = new Map<string, Date>();
  for (const change of changes) {
    const credentialId =
      change.entity === VaultEntity.EMAIL_CREDENTIAL
        ? change.entityId
        : credentialByAlias.get(change.entityId);
    if (!credentialId) continue;

    if (change.appliedAt === null) {
      // Oldest wins for pending, newest for confirmed -- same rule as the profiles above.
      if (!pending.has(credentialId)) pending.set(credentialId, change.at);
    } else {
      confirmed.set(credentialId, change.appliedAt);
    }
  }

  return rows.map((row) => ({
    ...row,
    pendingSince: pending.get(row.id) ?? null,
    confirmedAt: confirmed.get(row.id) ?? null,
  }));
}

/**
 * Retailer emails a member has profiles for but no app password yet.
 *
 * Drives the nudge on the page: these are the inboxes that will need a code chased by
 * hand during a drop.
 */
export async function getEmailsNeedingAppPassword(discordUserId: string): Promise<string[]> {
  const [accounts, coverage] = await Promise.all([
    prisma.vaultAccount.findMany({
      where: { discordUserId, active: true },
      select: { email: true, siteKey: true },
    }),
    loadMailboxCoverage(discordUserId),
  ]);

  // A forwarded address is covered, so it is not "needing" anything -- and neither is an
  // address on a retailer that never emails a code (Pokémon Center checks out as a guest).
  const have = coverage.destination;
  const relevant = accounts.filter((a) => siteStyle(a.siteKey).usesEmailCodes !== false);
  return [...new Set(relevant.map((a) => a.email.toLowerCase()))]
    .filter((e) => !have.has(e))
    .sort();
}

/**
 * The name a member's next profile on a site will be given.
 *
 * Computed here so the add form can show it before saving. The action recomputes it at
 * write time rather than trusting this -- a preview rendered minutes ago can be stale
 * if another profile was added in the meantime.
 */
export async function getNextProfileName(
  discordUserId: string,
  siteKey: string,
  discordUsername: string,
): Promise<string> {
  const all = await prisma.vaultProfile.findMany({
    where: { siteKey },
    select: { name: true, discordUserId: true },
  });
  const mine = all.filter((p) => p.discordUserId === discordUserId).map((p) => p.name);
  return nextProfileName(
    profileBaseFor(mine, discordUsername),
    all.map((p) => p.name),
  );
}
