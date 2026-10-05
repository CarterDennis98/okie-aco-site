/**
 * Who is run for what: the rule from a member's picks to the TCINs on each profile's task.
 *
 * Pure, so it can be tested without a database, and shared: the products page counts by it
 * and the Shikari export builds every checkout task from it.
 */

/** One member's pick of one product: every profile, or the ones listed. */
export type Choice = { all: boolean; profileIds: string[] };

export type SelectionRow = {
  productId: string;
  discordUserId: string;
  allProfiles: boolean;
  profileIds: string[];
};

/**
 * The TCINs each profile runs for, in `catalog` order.
 *
 * `catalog` is the ACTIVE products only, in watch order; a pick of a retired product simply
 * matches nothing, which is what retiring it means. A profile with no picks maps to an empty
 * list rather than being left out, so a caller can tell "picked nothing" from "unknown".
 */
export function skusByProfile(
  profiles: { id: string; discordUserId: string }[],
  selections: SelectionRow[],
  catalog: { id: string; sku: string }[],
): Map<string, string[]> {
  const byMember = new Map<string, SelectionRow[]>();
  for (const row of selections) {
    byMember.set(row.discordUserId, [...(byMember.get(row.discordUserId) ?? []), row]);
  }
  const result = new Map<string, string[]>();
  for (const profile of profiles) {
    const picks = byMember.get(profile.discordUserId) ?? [];
    const chosen = new Set(
      picks
        .filter((row) => row.allProfiles || row.profileIds.includes(profile.id))
        .map((row) => row.productId),
    );
    result.set(
      profile.id,
      catalog.filter((product) => chosen.has(product.id)).map((product) => product.sku),
    );
  }
  return result;
}
