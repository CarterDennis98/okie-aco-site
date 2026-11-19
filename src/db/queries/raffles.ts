import "server-only";

import { prisma } from "@/db/client";
import { rafflesByProfile, type EntryChoice, type EntryRow } from "@/lib/raffles/entries";

/**
 * Reads for raffles and members' entries in them.
 *
 * No secrets live here. Member-scoped reads take `discordUserId` as a required argument,
 * sourced only from the guard, like every other member query.
 */

export type RaffleRow = {
  id: string;
  sku: string;
  name: string;
  url: string;
  imageUrl: string | null;
  priceCents: number | null;
  startsAt: Date;
  dueAt: Date;
  createdAt: Date;
};

const RAFFLE_SELECT = {
  id: true,
  sku: true,
  name: true,
  url: true,
  imageUrl: true,
  priceCents: true,
  startsAt: true,
  dueAt: true,
  createdAt: true,
} as const;

/**
 * A retailer's raffles still taking entries, soonest due first. `includeClosed` adds the ones
 * that are due, after them -- for the page's "Past raffles", and the export's groups.
 */
export async function getRaffles(
  siteKey: string,
  { includeClosed = false, now = new Date() }: { includeClosed?: boolean; now?: Date } = {},
): Promise<RaffleRow[]> {
  const rows = await prisma.raffle.findMany({
    where: { siteKey, ...(includeClosed ? {} : { dueAt: { gt: now } }) },
    orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }],
    select: RAFFLE_SELECT,
  });
  // Closed ones after every open one, most recently closed first: an admin's list leads with
  // what members can still enter.
  const open = rows.filter((r) => r.dueAt > now);
  const closed = rows.filter((r) => r.dueAt <= now).reverse();
  return [...open, ...closed];
}

/** One member's entries on a retailer, by raffle id. A raffle they haven't entered is absent. */
export async function getMemberRaffleEntries(
  discordUserId: string,
  siteKey: string,
): Promise<Record<string, EntryChoice>> {
  const rows = await prisma.raffleEntry.findMany({
    where: { discordUserId, raffle: { siteKey } },
    select: { raffleId: true, allProfiles: true, profiles: { select: { profileId: true } } },
  });
  return Object.fromEntries(
    rows.map((row) => [
      row.raffleId,
      { all: row.allProfiles, profileIds: row.profiles.map((p) => p.profileId) },
    ]),
  );
}

/** Every entry in a retailer's raffles -- or these members' only. */
export async function getRaffleEntries(
  siteKey: string,
  discordUserIds?: string[],
): Promise<EntryRow[]> {
  const rows = await prisma.raffleEntry.findMany({
    where: {
      raffle: { siteKey },
      ...(discordUserIds ? { discordUserId: { in: discordUserIds } } : {}),
    },
    select: {
      raffleId: true,
      discordUserId: true,
      allProfiles: true,
      profiles: { select: { profileId: true } },
    },
  });
  return rows.map((row) => ({
    raffleId: row.raffleId,
    discordUserId: row.discordUserId,
    allProfiles: row.allProfiles,
    profileIds: row.profiles.map((p) => p.profileId),
  }));
}

export type RaffleCount = {
  /** Members with an active profile it enters. */
  members: number;
  /** Active profiles it enters. */
  profiles: number;
  /** Entries on file, whatever their profiles: what deleting it deletes. */
  entries: number;
};

/**
 * How many members and ACTIVE profiles each raffle would enter, for an admin's view of the
 * page -- on every runner's bot. Counted by the rule the export builds entry tasks with, so
 * the two never disagree.
 */
export async function getRaffleCounts(siteKey: string): Promise<Record<string, RaffleCount>> {
  const [raffles, entries] = await Promise.all([
    getRaffles(siteKey, { includeClosed: true }),
    getRaffleEntries(siteKey),
  ]);
  const members = [...new Set(entries.map((e) => e.discordUserId))];
  const profiles = await prisma.vaultProfile.findMany({
    where: { siteKey, active: true, discordUserId: { in: members } },
    select: { id: true, discordUserId: true },
  });
  const entered = rafflesByProfile(profiles, entries, raffles);

  const counts: Record<string, RaffleCount> = {};
  const idBySku = new Map(raffles.map((r) => [r.sku, r.id]));
  const owners = new Map<string, Set<string>>();
  for (const raffle of raffles) counts[raffle.id] = { members: 0, profiles: 0, entries: 0 };
  for (const entry of entries) if (counts[entry.raffleId]) counts[entry.raffleId].entries += 1;
  for (const profile of profiles) {
    for (const sku of entered.get(profile.id) ?? []) {
      const id = idBySku.get(sku);
      if (!id) continue;
      counts[id].profiles += 1;
      owners.set(id, (owners.get(id) ?? new Set<string>()).add(profile.discordUserId));
    }
  }
  for (const [id, who] of owners) counts[id].members = who.size;
  return counts;
}
