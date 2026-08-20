import "server-only";

import { prisma } from "@/db/client";
import { loadMailboxCoverage, mailboxFor } from "@/db/queries/email-coverage";
import { isExpired, maskedLabel } from "@/lib/vault/card";
import { normalizePhone } from "@/lib/vault/profile-input";
import { siteRequiresPhone, siteStyle } from "@/lib/sites";

/**
 * Admin reads over the whole vault.
 *
 * Callers MUST have passed `requireAdmin()` first -- nothing here re-checks, because a
 * query module that quietly enforced authorization would make it tempting to skip the
 * guard on the page. Same split as the member queries: reads never decrypt, and the
 * `*_enc` columns are not selected at all. The only decryption in the system is the
 * export route.
 */

export type AdminMemberRow = {
  discordUserId: string;
  username: string;
  displayName: string;
  profileCount: number;
  activeCount: number;
  onBackup: number;
  expiredCards: number;
  missingAppPasswords: number;
  /**
   * Profiles with no USABLE phone number, on a retailer that cannot check out without one.
   *
   * Counts a bot placeholder like "0" as missing, which it is here specifically: Walmart
   * calls or texts the number, so one Valor invents at checkout is no better than none.
   * The same value on Pokémon Center is correct and deliberate -- see BOT_SENTINEL_PHONE.
   *
   * Always 0 elsewhere. These are the profiles that were saved before the phone became
   * required and have been failing every order since -- the form now blocks new ones, but
   * the existing ones only get fixed if somebody can see them.
   */
  missingPhone: number;
};

/** Every member holding at least one profile on a site, for the picker. */
export async function getMembersForSite(siteKey: string): Promise<AdminMemberRow[]> {
  const [profiles, members, coverage] = await Promise.all([
    prisma.vaultProfile.findMany({
      where: { siteKey },
      select: {
        discordUserId: true,
        name: true,
        active: true,
        phone: true,
        cardExpMonth: true,
        cardExpYear: true,
        account: { select: { email: true } },
      },
    }),
    prisma.discordMember.findMany({
      select: { discordUserId: true, username: true, globalName: true },
    }),
    loadMailboxCoverage(),
  ]);

  const nameById = new Map(members.map((m) => [m.discordUserId, m]));

  const cap = siteStyle(siteKey).profileSoftCap;
  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

  const byMember = new Map<string, typeof profiles>();
  for (const profile of profiles) {
    const list = byMember.get(profile.discordUserId) ?? [];
    list.push(profile);
    byMember.set(profile.discordUserId, list);
  }

  const rows: AdminMemberRow[] = [];
  for (const [discordUserId, list] of byMember) {
    list.sort((a, b) => collator.compare(a.name, b.name));

    const active = list.filter((p) => p.active);
    const member = nameById.get(discordUserId);

    rows.push({
      discordUserId,
      username: member?.username ?? discordUserId,
      displayName: member?.globalName ?? member?.username ?? discordUserId,
      profileCount: list.length,
      activeCount: active.length,
      onBackup: cap === undefined ? 0 : Math.max(0, active.length - cap),
      expiredCards: list.filter((p) => isExpired(p.cardExpMonth, p.cardExpYear)).length,
      // Counted over ACTIVE profiles only: a disabled one isn't running, so it isn't
      // failing orders and isn't the thing to chase.
      missingPhone: siteRequiresPhone(siteKey)
        ? active.filter((p) => !normalizePhone(p.phone)).length
        : 0,
      // Counts addresses with nowhere to read a code from. An address that forwards into
      // a mailbox with a password is covered, so it is not missing one -- and a retailer
      // that never sends a code has nothing to miss.
      missingAppPasswords:
        siteStyle(siteKey).usesEmailCodes === false
          ? 0
          : new Set(
              list
                .map((p) => p.account.email.toLowerCase())
                .filter((e) => mailboxFor(coverage, e) === null),
            ).size,
    });
  }

  return rows.sort((a, b) => collator.compare(a.username, b.username));
}

export type AdminProfileRow = {
  id: string;
  name: string;
  active: boolean;
  email: string;
  fullName: string;
  phone: string | null;
  cardLabel: string;
  cardExpiry: string;
  cardExpired: boolean;
  shipping: string;
  billing: string | null;
  /** Where this account's codes land: itself, another inbox, or nowhere. */
  mailbox: string | null;
  updatedAt: Date;
  onBackup: boolean;
};

function formatAddress(parts: (string | null)[]): string {
  return parts.filter(Boolean).join(", ");
}

/** One member's full picture for a site. Still no secrets. */
export async function getMemberVaultForAdmin(
  siteKey: string,
  discordUserId: string,
): Promise<AdminProfileRow[]> {
  const [profiles, coverage] = await Promise.all([
    prisma.vaultProfile.findMany({
      where: { siteKey, discordUserId },
      include: { account: { select: { email: true } } },
    }),
    loadMailboxCoverage(discordUserId),
  ]);
  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  profiles.sort((a, b) => collator.compare(a.name, b.name));

  const cap = siteStyle(siteKey).profileSoftCap;
  let slot = 0;

  return profiles.map((p) => {
    if (p.active) slot += 1;
    return {
      id: p.id,
      name: p.name,
      active: p.active,
      email: p.account.email,
      fullName: `${p.firstName} ${p.lastName}`.trim(),
      phone: p.phone,
      cardLabel: maskedLabel(p.cardBrand, p.cardLast4),
      cardExpiry: `${p.cardExpMonth}/${p.cardExpYear.slice(-2)}`,
      cardExpired: isExpired(p.cardExpMonth, p.cardExpYear),
      shipping: formatAddress([
        p.shipLine1,
        p.shipLine2,
        `${p.shipCity}, ${p.shipState} ${p.shipPostalCode}`,
      ]),
      billing: p.sameBillingAndShipping
        ? null
        : formatAddress([
            p.billLine1,
            p.billLine2,
            `${p.billCity ?? ""}, ${p.billState ?? ""} ${p.billPostalCode ?? ""}`.trim(),
          ]),
      mailbox: mailboxFor(coverage, p.account.email),
      updatedAt: p.updatedAt,
      onBackup: cap !== undefined && p.active && slot > cap,
    };
  });
}

/** Sites that actually have profiles, so the picker only offers real choices. */
export async function getSitesWithProfiles(): Promise<{ siteKey: string; count: number }[]> {
  const grouped = await prisma.vaultProfile.groupBy({
    by: ["siteKey"],
    _count: { _all: true },
  });
  return grouped
    .map((g) => ({ siteKey: g.siteKey, count: g._count._all }))
    .sort((a, b) => b.count - a.count);
}
