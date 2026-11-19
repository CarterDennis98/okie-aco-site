import { skusByProfile, type SelectionRow } from "@/lib/products/selection";
import { raffleTimeLabel, toZonedInput } from "@/lib/raffles/time";

/**
 * Who is entered in what: the rule from a member's raffle entries to the raffles each of their
 * profiles is entered in, and where a raffle stands.
 *
 * Pure, so it can be tested without a database, and shared: the products page counts by it
 * and the Shikari export builds every raffle task from it.
 */

/** One member's entry in one raffle: every profile they hold there, or the ones listed. */
export type EntryChoice = { all: boolean; profileIds: string[] };

export type EntryRow = {
  raffleId: string;
  discordUserId: string;
  allProfiles: boolean;
  profileIds: string[];
};

/**
 * The raffles each profile is entered in, as SKUs in `raffles` order.
 *
 * Exactly a product pick's rule (skusByProfile) -- an entry is a pick of a raffle -- so "all
 * profiles" means the same thing in both places: every profile the member holds, including
 * ones added since. A profile entered in nothing maps to an empty list.
 */
export function rafflesByProfile(
  profiles: { id: string; discordUserId: string }[],
  entries: EntryRow[],
  raffles: { id: string; sku: string }[],
): Map<string, string[]> {
  const rows: SelectionRow[] = entries.map((e) => ({
    productId: e.raffleId,
    discordUserId: e.discordUserId,
    allProfiles: e.allProfiles,
    profileIds: e.profileIds,
  }));
  return skusByProfile(profiles, rows, raffles);
}

/**
 * What a member's entry comes to, for the page to say once entries are due: null for none, or
 * every profile ("all") or the ones listed -- by name, active ones only, in the order given,
 * since an export enters no others.
 */
export function enteredWith(
  entry: EntryChoice | undefined,
  profiles: { id: string; name: string; active: boolean }[],
): { all: boolean; names: string[] } | null {
  if (!entry) return null;
  const active = profiles.filter((p) => p.active);
  return {
    all: entry.all,
    names: (entry.all ? active : active.filter((p) => entry.profileIds.includes(p.id))).map(
      (p) => p.name,
    ),
  };
}

/**
 * Where a raffle stands:
 *
 *   upcoming  listed, not started on Target yet -- members can already enter
 *   live      started, entries not yet due
 *   closed    entries are due: no more entering, changing or withdrawing
 */
export type RafflePhase = "upcoming" | "live" | "closed";

export function rafflePhase(raffle: { startsAt: Date; dueAt: Date }, now: Date): RafflePhase {
  if (now >= raffle.dueAt) return "closed";
  return now >= raffle.startsAt ? "live" : "upcoming";
}

/** A raffle as the page shows it, its times already in words -- see toRaffleView. */
export type RaffleView = {
  id: string;
  sku: string;
  name: string;
  url: string;
  imageUrl: string | null;
  priceCents: number | null;
  phase: RafflePhase;
  /** "Fri, Nov 21, 9:00 AM CT". */
  startsLabel: string;
  dueLabel: string;
  /** "2026-11-21T09:00", Central: what the editor's inputs start from. */
  startsInput: string;
  dueInput: string;
};

/**
 * A raffle for the page. Its times are put into words on the server, once, so the page the
 * server renders and the one the browser takes over agree to the character.
 */
export function toRaffleView(
  raffle: {
    id: string;
    sku: string;
    name: string;
    url: string;
    imageUrl: string | null;
    priceCents: number | null;
    startsAt: Date;
    dueAt: Date;
  },
  now: Date,
): RaffleView {
  return {
    id: raffle.id,
    sku: raffle.sku,
    name: raffle.name,
    url: raffle.url,
    imageUrl: raffle.imageUrl,
    priceCents: raffle.priceCents,
    phase: rafflePhase(raffle, now),
    startsLabel: raffleTimeLabel(raffle.startsAt),
    dueLabel: raffleTimeLabel(raffle.dueAt),
    startsInput: toZonedInput(raffle.startsAt),
    dueInput: toZonedInput(raffle.dueAt),
  };
}
