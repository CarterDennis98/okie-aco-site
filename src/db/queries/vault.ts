import "server-only";

import { prisma } from "@/db/client";
import { siteStyle } from "@/lib/sites";
import { loadMailboxCoverage, mailboxFor, type MailboxCoverage } from "@/db/queries/email-coverage";
import { isExpired, maskedLabel } from "@/lib/vault/card";
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
  shipCity: string;
  shipState: string;
  sameBillingAndShipping: boolean;
  // The mailbox this profile's verification codes land in: the account email itself when
  // it holds an app password, a different address when it forwards into one, null when
  // nothing covers it. The password is never carried here -- the reveal action fetches
  // it, and audits the read.
  mailbox: string | null;
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

export type EmailCredentialSummary = {
  id: string;
  email: string;
  verifiedAt: Date | null;
  lastError: string | null;
  updatedAt: Date;
  /** Addresses that forward into this mailbox, so one password covers all of them. */
  aliases: { id: string; email: string }[];
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

function toSummary(row: SummaryRow, coverage?: MailboxCoverage): VaultProfileSummary {
  return {
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
  const [rows, coverage] = await Promise.all([
    prisma.vaultProfile.findMany({ where: { discordUserId }, select: SUMMARY_SELECT }),
    loadMailboxCoverage(discordUserId),
  ]);

  const bySite = new Map<string, VaultProfileSummary[]>();
  for (const row of rows) {
    const list = bySite.get(row.siteKey) ?? [];
    list.push(toSummary(row, coverage));
    bySite.set(row.siteKey, list);
  }

  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  for (const list of bySite.values()) list.sort((a, b) => collator.compare(a.name, b.name));

  return [...bySite.entries()]
    .map(([siteKey, profiles]) => ({ siteKey, profiles }))
    .sort((a, b) => a.siteKey.localeCompare(b.siteKey));
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
  // summary about coverage would be a trap for the next caller.
  const coverage = await loadMailboxCoverage(discordUserId);

  return {
    ...toSummary(row, coverage),
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
 * Email app passwords.
 *
 * The password itself is never selected -- only whether one exists, and whether it last
 * worked. `hasPassword` is derived from a non-empty ciphertext rather than returning it.
 */
export async function getMemberEmailCredentials(
  discordUserId: string,
): Promise<EmailCredentialSummary[]> {
  const rows = await prisma.emailCredential.findMany({
    where: { discordUserId },
    orderBy: { email: "asc" },
    select: {
      id: true,
      email: true,
      verifiedAt: true,
      lastError: true,
      updatedAt: true,
      aliases: { select: { id: true, email: true }, orderBy: { email: "asc" } },
    },
  });
  return rows;
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
