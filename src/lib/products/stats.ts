import { skusByProfile, type SelectionRow } from "@/lib/products/selection";

/**
 * The summary on Target Products, for admins: who is being run, on how many profiles, for
 * what. Pure -- the database read is getDropStats -- so the counting rules are tested on
 * their own, by the same rule the export builds tasks with (skusByProfile).
 */

export type DropStats = {
  /** Members with an active profile on this retailer: everyone who could be run. */
  members: number;
  /** Of those, the ones with at least one product running on at least one profile. */
  running: number;
  /** The rest, by name: who hasn't picked anything that runs. */
  idle: { discordUserId: string; name: string }[];
  /** Active profiles, and how many of them run at least one product. */
  profiles: number;
  profilesRunning: number;
  /** Member-and-product pairs that run on at least one of the member's active profiles. */
  selections: number;
  /** Profile-and-product pairs: the checkout lines an export builds. */
  runs: number;
  /** Live products, and how many distinct ones the watchdogs watch. */
  products: number;
  watched: number;
  /** The most-run products, by profiles. */
  top: { id: string; name: string; setName: string; members: number; profiles: number }[];
};

/**
 * Every figure but the idle members' names, which come back as ids for the caller to look up.
 *
 * `catalog` is the live products, `profiles` every ACTIVE profile on the retailer, and
 * `selections` every pick of a live product.
 */
export function countDrops(
  catalog: { id: string; sku: string; name: string; setName: string }[],
  selections: SelectionRow[],
  profiles: { id: string; discordUserId: string }[],
): { stats: Omit<DropStats, "idle">; idleIds: string[] } {
  const skus = skusByProfile(profiles, selections, catalog);

  const memberSkus = new Map<string, Set<string>>();
  const profilesBySku = new Map<string, number>();
  const membersBySku = new Map<string, Set<string>>();
  let runs = 0;
  let profilesRunning = 0;
  for (const profile of profiles) {
    const list = skus.get(profile.id) ?? [];
    const set = memberSkus.get(profile.discordUserId) ?? new Set<string>();
    for (const sku of list) {
      set.add(sku);
      profilesBySku.set(sku, (profilesBySku.get(sku) ?? 0) + 1);
      membersBySku.set(sku, (membersBySku.get(sku) ?? new Set()).add(profile.discordUserId));
    }
    memberSkus.set(profile.discordUserId, set);
    runs += list.length;
    if (list.length > 0) profilesRunning += 1;
  }
  const idleIds = [...memberSkus].filter(([, set]) => set.size === 0).map(([id]) => id);

  return {
    idleIds,
    stats: {
      members: memberSkus.size,
      running: memberSkus.size - idleIds.length,
      profiles: profiles.length,
      profilesRunning,
      selections: [...memberSkus.values()].reduce((sum, set) => sum + set.size, 0),
      runs,
      products: catalog.length,
      watched: profilesBySku.size,
      top: catalog
        .filter((p) => profilesBySku.has(p.sku))
        .map((p) => ({
          id: p.id,
          name: p.name,
          setName: p.setName,
          members: membersBySku.get(p.sku)?.size ?? 0,
          profiles: profilesBySku.get(p.sku) ?? 0,
        }))
        .sort((a, b) => b.profiles - a.profiles || b.members - a.members)
        .slice(0, 5),
    },
  };
}
