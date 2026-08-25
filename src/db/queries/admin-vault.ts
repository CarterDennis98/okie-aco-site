import "server-only";

import { prisma } from "@/db/client";
import { loadMailboxCoverage, mailboxFor } from "@/db/queries/email-coverage";
// VaultEntity as a VALUE, not just a type: the mailbox query filters on it. The generated
// module exports a const and a matching type under each name, so this covers both uses.
import { VaultEntity, type VaultAction } from "@/generated/prisma/enums";
import { isExpired, maskedLabel } from "@/lib/vault/card";
import { providerForEmail } from "@/lib/vault/email-providers";
import { normalizePhone } from "@/lib/vault/profile-input";
import { siteRequiresPhone, siteStyle } from "@/lib/sites";
import { EMAIL_BUCKET } from "@/lib/vault/pending-filter";
import {
  isProfileFilterActive,
  matchesProfileFilter,
  type ProfileFilter,
} from "@/lib/vault/profile-filter";

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
  /**
   * How many of this member's profiles match the search / active filter.
   *
   * Equal to `profileCount` when no filter is set. The counts above stay UNFILTERED on
   * purpose -- "3 match · 18/24 active" is the useful line, and recomputing "active" over
   * a search result would make the roster's own numbers change meaning as you type.
   */
  matchCount: number;
};

/**
 * Every member holding at least one profile on a site, for the picker.
 *
 * Returns EVERY member regardless of the filter, with `matchCount` per row. Dropping
 * non-matching members here would 404 the page the moment a search excluded whoever was
 * already open -- the page validates `?member=` against this list, so it has to stay the
 * full roster and the display filtering happens in the picker.
 */
export async function getMembersForSite(
  siteKey: string,
  filter?: ProfileFilter,
): Promise<AdminMemberRow[]> {
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
        // Selected for the search, not for the roster's own display: the matcher looks at
        // the same fields here as it does in the profile table, so a member counted as
        // matching always has a row to show.
        firstName: true,
        lastName: true,
        shipCity: true,
        shipState: true,
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
      matchCount:
        filter && isProfileFilterActive(filter)
          ? list.filter((p) => matchesProfileFilter({ ...p, email: p.account.email }, filter))
              .length
          : list.length,
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

/**
 * One member's full picture for a site. Still no secrets.
 *
 * `total` is the unfiltered count, so the table can say "showing 3 of 27" rather than
 * silently presenting a search result as everything the member owns.
 *
 * The bot split is computed BEFORE the filter is applied. A profile's slot on the main bot
 * depends on where it falls in the member's whole active list, so filtering first would
 * have a search for one profile report it as running on the main bot when it doesn't.
 */
export async function getMemberVaultForAdmin(
  siteKey: string,
  discordUserId: string,
  filter?: ProfileFilter,
): Promise<{ rows: AdminProfileRow[]; total: number }> {
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

  const rows = profiles.map((p) => {
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

  // Paired by index against the raw rows, which carry the columns the matcher reads. Doing
  // it here rather than in the `where` above is what keeps `onBackup` and `total` honest.
  const shown = filter
    ? rows.filter((_, i) =>
        matchesProfileFilter({ ...profiles[i], email: profiles[i].account.email }, filter),
      )
    : rows;

  return { rows: shown, total: rows.length };
}

// ---------------------------------------------------------------------------
// One member's mailboxes
// ---------------------------------------------------------------------------

export type AdminMailboxRow = {
  id: string;
  email: string;
  verifiedAt: Date | null;
  lastError: string | null;
  /** When a check last ran, pass or fail. Null means nobody has ever tested it. */
  lastCheckedAt: Date | null;
  updatedAt: Date;
  /** Addresses that forward into this mailbox, so one password covers all of them. */
  aliases: string[];
  /** Retailer accounts whose verification codes land here, and where each is used. */
  covers: { email: string; siteKeys: string[] }[];
};

export type AdminMemberEmails = {
  mailboxes: AdminMailboxRow[];
  /**
   * Retailer accounts with nowhere to read a code from. Restricted to retailers that
   * actually email one -- Pokémon Center checks out as a guest, so an uncovered address
   * there is not a gap.
   */
  uncovered: { email: string; siteKeys: string[] }[];
};

/**
 * Every mailbox one member holds an app password for, ACROSS ALL RETAILERS.
 *
 * Deliberately not site-scoped, unlike everything else on the admin profiles page. A
 * mailbox is not a per-retailer thing -- one Gmail commonly covers a member's Target,
 * Walmart and Pokémon Center accounts at once -- and the question this answers is "what
 * are this person's app passwords", which has no site in it. Reaching it by picking a
 * member under one retailer was the only path before, and it showed a third of the answer.
 *
 * Reads no ciphertext. `app_password_enc` is not selected at all; the reveal action
 * fetches it one row at a time and audits each read.
 */
export async function getMemberEmailsForAdmin(discordUserId: string): Promise<AdminMemberEmails> {
  const [credentials, accounts, coverage] = await Promise.all([
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
        aliases: { select: { email: true }, orderBy: { email: "asc" } },
      },
    }),
    prisma.vaultAccount.findMany({
      where: { discordUserId, active: true },
      select: { email: true, siteKey: true },
    }),
    loadMailboxCoverage(discordUserId),
  ]);

  // One account address can appear on several retailers, so collapse to address -> sites
  // before resolving coverage. Otherwise a member with the same email on Target and
  // Walmart shows the address twice under the same mailbox.
  //
  // RETAILERS THAT EMAIL A CODE, ONLY. This whole panel is about reading verification
  // codes, so listing a Pokémon Center account here says an app password serves it -- and
  // nothing does, because guest checkout never sends one. An address used on both Pokémon
  // Center and Walmart keeps only the Walmart chip; one used solely on Pokémon Center
  // drops out entirely rather than appearing as a gap somebody should go and fix.
  const sitesByEmail = new Map<string, Set<string>>();
  for (const account of accounts) {
    if (siteStyle(account.siteKey).usesEmailCodes === false) continue;
    const key = account.email.toLowerCase();
    const set = sitesByEmail.get(key) ?? new Set<string>();
    set.add(account.siteKey);
    sitesByEmail.set(key, set);
  }

  const coversByMailbox = new Map<string, { email: string; siteKeys: string[] }[]>();
  const uncovered: { email: string; siteKeys: string[] }[] = [];

  for (const [email, siteSet] of sitesByEmail) {
    const siteKeys = [...siteSet].sort();
    const mailbox = mailboxFor(coverage, email);

    if (mailbox === null) {
      uncovered.push({ email, siteKeys });
      continue;
    }
    const key = mailbox.toLowerCase();
    coversByMailbox.set(key, [...(coversByMailbox.get(key) ?? []), { email, siteKeys }]);
  }

  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

  return {
    mailboxes: credentials.map((credential) => ({
      id: credential.id,
      email: credential.email,
      verifiedAt: credential.verifiedAt,
      lastError: credential.lastError,
      lastCheckedAt: credential.lastCheckedAt,
      updatedAt: credential.updatedAt,
      aliases: credential.aliases.map((a) => a.email),
      covers: (coversByMailbox.get(credential.email.toLowerCase()) ?? []).sort((a, b) =>
        collator.compare(a.email, b.email),
      ),
    })),
    uncovered: uncovered.sort((a, b) => collator.compare(a.email, b.email)),
  };
}

// ---------------------------------------------------------------------------
// Every mailbox, across every member
// ---------------------------------------------------------------------------

export type AdminImapRow = {
  id: string;
  email: string;
  ownerDiscordId: string;
  /** globalName when they have one, so the roster reads like Discord does. */
  ownerName: string;
  ownerUsername: string;
  /** The provider we recognized the domain as, or null for one saved before it was known. */
  provider: string | null;
  imapHost: string | null;
  imapPort: number | null;
  verifiedAt: Date | null;
  lastError: string | null;
  /** When a check last ran, pass or fail. Null means nobody has ever tested it. */
  lastCheckedAt: Date | null;
  updatedAt: Date;
  /** When the oldest unconfirmed change to this mailbox was made. Null when nothing waits. */
  pendingSince: Date | null;
  /** Addresses that forward in here, so one password covers all of them. */
  aliases: string[];
  /** Retailer accounts whose verification codes land here, and where each is used. */
  covers: { email: string; siteKeys: string[] }[];
};

export type AdminImapView = {
  rows: AdminImapRow[];
  /** Every mailbox on file, ignoring the search. */
  total: number;
  /** How many matched the search. Can exceed `rows.length` -- see IMAP_LIMIT. */
  shown: number;
  /** Distinct members holding at least one mailbox. */
  memberCount: number;
  /** Mailboxes whose last IMAP check failed. */
  failingCount: number;
  /** Retailer accounts with nowhere to read a code from, by owner. */
  uncovered: {
    discordUserId: string;
    username: string;
    accounts: { email: string; siteKeys: string[] }[];
  }[];
  /** Total uncovered addresses, which is what the headline number should say. */
  uncoveredCount: number;
};

/**
 * One member's name, for a page reached by `?member=<id>` alone.
 *
 * Exists so a member with no mailboxes still renders as themselves -- "no app passwords on
 * file" against their name is a real and actionable state, and deriving the name from the
 * mailbox rows would 404 exactly the people worth looking at. Null means the id is not a
 * member, which is a typed URL rather than a state to render.
 */
export async function getMemberIdentity(
  discordUserId: string,
): Promise<{ username: string; displayName: string } | null> {
  const member = await prisma.discordMember.findUnique({
    where: { discordUserId },
    select: { username: true, globalName: true },
  });
  if (!member) return null;
  return { username: member.username, displayName: member.globalName ?? member.username };
}

/**
 * Cap on rendered mailbox rows. Each one carries its aliases and every account it covers,
 * so a few hundred is already a long page; the search is how you get to a specific one,
 * and `shown` reports what the cap left out.
 */
const IMAP_LIMIT = 300;

/**
 * Every app password on file, with who owns it and what it covers.
 *
 * NOT SITE-SCOPED, and that is the whole point. A mailbox belongs to a person: one Gmail
 * routinely serves the same member's Target, Walmart and Pokémon Center accounts, so
 * "what app passwords do we hold" is a question with no retailer in it. Reaching these
 * through a retailer picker showed a slice of the answer and produced one export file per
 * retailer for a credential set that does not split that way.
 *
 * Reads no ciphertext. `app_password_enc` is not selected; the reveal action fetches one
 * row at a time and audits each read.
 */
export async function getAllMailboxesForAdmin(options?: {
  search?: string;
  /** Restrict to one member, for the per-member view. */
  discordUserId?: string;
}): Promise<AdminImapView> {
  const scope = options?.discordUserId ? { discordUserId: options.discordUserId } : {};
  const terms = (options?.search ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 10);

  const [credentials, accounts, members, coverage, pendingChanges] = await Promise.all([
    prisma.emailCredential.findMany({
      where: scope,
      orderBy: { email: "asc" },
      select: {
        id: true,
        email: true,
        discordUserId: true,
        imapHost: true,
        imapPort: true,
        verifiedAt: true,
        lastError: true,
        lastCheckedAt: true,
        updatedAt: true,
        aliases: { select: { email: true }, orderBy: { email: "asc" } },
      },
    }),
    prisma.vaultAccount.findMany({
      where: { active: true, ...scope },
      select: { email: true, siteKey: true, discordUserId: true },
    }),
    prisma.discordMember.findMany({
      select: { discordUserId: true, username: true, globalName: true },
    }),
    // Coverage is deliberately UNSCOPED even for one member: an alias row is unique
    // globally, and scoping it would make an address look uncovered here and covered on
    // the export, which is the one disagreement that costs somebody a code mid-drop.
    loadMailboxCoverage(),
    prisma.vaultChange.findMany({
      where: { appliedAt: null, entity: VaultEntity.EMAIL_CREDENTIAL },
      orderBy: { at: "asc" },
      select: { entityId: true, at: true },
    }),
  ]);

  const memberById = new Map(members.map((m) => [m.discordUserId, m]));

  // Oldest unconfirmed change per mailbox: "waiting since this morning" is the useful
  // sentence, not "since ten minutes ago". Same rule as the member-facing pages.
  const pending = new Map<string, Date>();
  for (const change of pendingChanges) {
    if (!pending.has(change.entityId)) pending.set(change.entityId, change.at);
  }

  // Address -> the retailers it is used on, restricted to retailers that actually email a
  // code. A Pokémon Center account checks out as a guest, so listing it here would claim
  // an app password serves it when nothing does.
  const sitesByEmail = new Map<string, { sites: Set<string>; owner: string }>();
  for (const account of accounts) {
    if (siteStyle(account.siteKey).usesEmailCodes === false) continue;
    const key = account.email.toLowerCase();
    const entry = sitesByEmail.get(key) ?? {
      sites: new Set<string>(),
      owner: account.discordUserId,
    };
    entry.sites.add(account.siteKey);
    sitesByEmail.set(key, entry);
  }

  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  const coversByMailbox = new Map<string, { email: string; siteKeys: string[] }[]>();
  const uncoveredByMember = new Map<string, { email: string; siteKeys: string[] }[]>();

  for (const [email, { sites, owner }] of sitesByEmail) {
    const siteKeys = [...sites].sort();
    const mailbox = mailboxFor(coverage, email);
    if (mailbox === null) {
      uncoveredByMember.set(owner, [...(uncoveredByMember.get(owner) ?? []), { email, siteKeys }]);
      continue;
    }
    const key = mailbox.toLowerCase();
    coversByMailbox.set(key, [...(coversByMailbox.get(key) ?? []), { email, siteKeys }]);
  }

  const all: AdminImapRow[] = credentials.map((credential) => {
    const owner = memberById.get(credential.discordUserId);
    return {
      id: credential.id,
      email: credential.email,
      ownerDiscordId: credential.discordUserId,
      // Falls back to the id: a mailbox belonging to someone who has left the server is
      // still a live credential on the bot, and a blank name would read as a broken row.
      ownerName: owner?.globalName ?? owner?.username ?? credential.discordUserId,
      ownerUsername: owner?.username ?? credential.discordUserId,
      provider: providerForEmail(credential.email)?.label ?? null,
      imapHost: credential.imapHost,
      imapPort: credential.imapPort,
      verifiedAt: credential.verifiedAt,
      lastError: credential.lastError,
      lastCheckedAt: credential.lastCheckedAt,
      updatedAt: credential.updatedAt,
      pendingSince: pending.get(credential.id) ?? null,
      aliases: credential.aliases.map((a) => a.email),
      covers: (coversByMailbox.get(credential.email.toLowerCase()) ?? []).sort((a, b) =>
        collator.compare(a.email, b.email),
      ),
    };
  });

  // Every term has to match something, same rule as the profile search: "carter gmail"
  // means that person's Gmail, not everyone's.
  const matches = (row: AdminImapRow) => {
    if (terms.length === 0) return true;
    const haystack = [
      row.email,
      row.ownerName,
      row.ownerUsername,
      row.provider ?? "",
      ...row.aliases,
      ...row.covers.map((c) => c.email),
    ]
      .join(" ")
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  };

  const matched = all.filter(matches);

  return {
    rows: matched.slice(0, IMAP_LIMIT),
    total: all.length,
    shown: matched.length,
    memberCount: new Set(all.map((r) => r.ownerDiscordId)).size,
    failingCount: all.filter((r) => r.lastError !== null).length,
    uncovered: [...uncoveredByMember.entries()]
      .map(([discordUserId, list]) => ({
        discordUserId,
        username: memberById.get(discordUserId)?.username ?? discordUserId,
        accounts: list.sort((a, b) => collator.compare(a.email, b.email)),
      }))
      .sort((a, b) => collator.compare(a.username, b.username)),
    uncoveredCount: [...uncoveredByMember.values()].reduce((sum, list) => sum + list.length, 0),
  };
}

// ---------------------------------------------------------------------------
// Changes waiting to reach the bot
// ---------------------------------------------------------------------------

export type PendingChangeRow = {
  id: string;
  at: Date;
  ownerDiscordId: string;
  username: string;
  siteKey: string | null;
  siteLabel: string;
  label: string | null;
  action: VaultAction;
  entity: VaultEntity;
  fields: string[];
};

/**
 * How many edits are waiting, per retailer, so the operator can clear one bot at a time.
 *
 * `siteKey` is null on mailbox changes -- an app password belongs to a person, not a
 * retailer -- and those are grouped under their own bucket rather than dropped.
 */
export type PendingChangeGroup = { siteKey: string | null; siteLabel: string; count: number };

/** Just the number, for the nav badge. Cheap enough to call on every admin page. */
export async function getPendingChangeCount(): Promise<number> {
  return prisma.vaultChange.count({ where: { appliedAt: null } });
}

/**
 * The edits a member has made that nobody has confirmed yet.
 *
 * Capped: a bulk import writes one row per profile, so a single upload can put 90 rows in
 * here, and the operator works through them a retailer at a time rather than reading every
 * line. The retailer filter is what makes that practical, and `total` still reports how many
 * there really are.
 */
const PENDING_LIMIT = 200;

export async function getPendingChanges(filter?: string): Promise<{
  rows: PendingChangeRow[];
  /** ALWAYS every bucket, with unfiltered counts -- these are the filter tabs. */
  groups: PendingChangeGroup[];
  /** Every pending change, regardless of the filter. Drives the heading and the badge. */
  total: number;
  /** The bucket actually in effect, after an unknown value falls back to everything. */
  active: string | null;
  /** How many are in the active bucket, so the list can say what it is showing. */
  shown: number;
}> {
  // Groups first, because they decide whether the requested filter is real. An unrecognized
  // one falls back to everything rather than rendering an empty queue with no tab lit --
  // same rule the charges page applies to its own filter.
  const [grouped, total] = await Promise.all([
    prisma.vaultChange.groupBy({
      by: ["siteKey"],
      where: { appliedAt: null },
      _count: { _all: true },
    }),
    getPendingChangeCount(),
  ]);

  const buckets = new Set(grouped.map((g) => g.siteKey ?? EMAIL_BUCKET));
  const active = filter && buckets.has(filter) ? filter : null;

  const changes = await prisma.vaultChange.findMany({
    where: {
      appliedAt: null,
      // Null is a real value here, not "no filter", so the email bucket needs its own token.
      ...(active === EMAIL_BUCKET ? { siteKey: null } : active ? { siteKey: active } : {}),
    },
    orderBy: { at: "desc" },
    take: PENDING_LIMIT,
    select: {
      id: true,
      at: true,
      ownerDiscordId: true,
      siteKey: true,
      label: true,
      action: true,
      entity: true,
      fields: true,
    },
  });

  const shown = active
    ? (grouped.find((g) => (g.siteKey ?? EMAIL_BUCKET) === active)?._count._all ?? 0)
    : total;

  // One lookup for the names rather than a join per row: `vault_changes.owner_discord_id`
  // is a plain column, not a relation, precisely so a change survives a member leaving.
  const owners = [...new Set(changes.map((c) => c.ownerDiscordId))];
  const members = await prisma.discordMember.findMany({
    where: { discordUserId: { in: owners } },
    select: { discordUserId: true, username: true, globalName: true },
  });
  const nameById = new Map(members.map((m) => [m.discordUserId, m.globalName ?? m.username]));

  return {
    rows: changes.map((change) => ({
      ...change,
      // Falls back to the id: a change by someone who has since left the server still has
      // to be markable, and showing a blank name would read as a broken row.
      username: nameById.get(change.ownerDiscordId) ?? change.ownerDiscordId,
      siteLabel: change.siteKey ? siteStyle(change.siteKey).label : "Email",
    })),
    groups: grouped
      .map((g) => ({
        siteKey: g.siteKey,
        siteLabel: g.siteKey ? siteStyle(g.siteKey).label : "Email",
        count: g._count._all,
      }))
      .sort((a, b) => b.count - a.count),
    total,
    active,
    shown,
  };
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
