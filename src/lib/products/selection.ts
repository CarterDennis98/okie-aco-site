/**
 * Who is run for what: the rule from a member's picks to the TCINs on each profile's task,
 * and the qty of each.
 *
 * Pure, so it can be tested without a database, and shared: the products page counts by it
 * and the Shikari export builds every checkout task from it.
 */

/**
 * One member's pick of one product: every profile, or the ones listed -- and how many of it
 * each one buys. `qty` is the pick's own (null: the standard qty), and `profileQty` holds a
 * profile's own where the member set one apart.
 */
export type Choice = {
  all: boolean;
  profileIds: string[];
  qty: number | null;
  profileQty: Record<string, number>;
};

export type SelectionRow = {
  productId: string;
  discordUserId: string;
  allProfiles: boolean;
  profileIds: string[];
  /** The pick's qty; null or absent, the standard qty. Only the export reads it. */
  qty?: number | null;
  /** A profile's own qty, by profile id, where it has one. Only the export reads it. */
  profileQty?: Record<string, number>;
};

/** Whether a member's pick runs on this profile of theirs. */
const runsOn = (row: SelectionRow, profileId: string) =>
  row.allProfiles || row.profileIds.includes(profileId);

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
  const byMember = groupByMember(selections);
  const result = new Map<string, string[]>();
  for (const profile of profiles) {
    const picks = byMember.get(profile.discordUserId) ?? [];
    const chosen = new Set(
      picks.filter((row) => runsOn(row, profile.id)).map((row) => row.productId),
    );
    result.set(
      profile.id,
      catalog.filter((product) => chosen.has(product.id)).map((product) => product.sku),
    );
  }
  return result;
}

/**
 * The qty each profile buys of each TCIN it runs, by TCIN, where its member picked one: the
 * profile's own, or failing that the pick's. A TCIN it runs that isn't listed runs at the
 * standard qty -- the export's to fill in (TaskSettings.checkoutQty). Exactly the products
 * skusByProfile gives the profile, so a qty can never put a product on a task by itself.
 */
export function qtysByProfile(
  profiles: { id: string; discordUserId: string }[],
  selections: SelectionRow[],
  catalog: { id: string; sku: string }[],
): Map<string, Record<string, number>> {
  const byMember = groupByMember(selections);
  const skuOf = new Map(catalog.map((product) => [product.id, product.sku]));
  const result = new Map<string, Record<string, number>>();
  for (const profile of profiles) {
    const qty: Record<string, number> = {};
    for (const row of byMember.get(profile.discordUserId) ?? []) {
      const sku = skuOf.get(row.productId);
      if (sku === undefined || !runsOn(row, profile.id)) continue;
      const own = row.profileQty?.[profile.id] ?? row.qty ?? null;
      if (own !== null) qty[sku] = own;
    }
    result.set(profile.id, qty);
  }
  return result;
}

function groupByMember(selections: SelectionRow[]): Map<string, SelectionRow[]> {
  const byMember = new Map<string, SelectionRow[]>();
  for (const row of selections) {
    byMember.set(row.discordUserId, [...(byMember.get(row.discordUserId) ?? []), row]);
  }
  return byMember;
}
