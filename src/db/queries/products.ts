import "server-only";

import { prisma } from "@/db/client";
import { skusByProfile, type Choice, type SelectionRow } from "@/lib/products/selection";
import { countDrops, type DropStats } from "@/lib/products/stats";

/**
 * Reads for drop products and members' picks of them.
 *
 * No secrets live here, so nothing is excluded from a select on that account. Member-scoped
 * reads take `discordUserId` as a required argument, sourced only from the guard, like every
 * other member query.
 */

export type CatalogProduct = {
  id: string;
  siteKey: string;
  setName: string;
  name: string;
  url: string;
  sku: string;
  priceCents: number | null;
  /** The PAS fee per unit members are shown. Display only; see DropProduct. */
  pasFeeCents: number | null;
  imageUrl: string | null;
  /** Its place in its set on the page; see lib/products/sets.ts. */
  sortOrder: number;
  active: boolean;
  createdAt: Date;
};

const PRODUCT_SELECT = {
  id: true,
  siteKey: true,
  setName: true,
  name: true,
  url: true,
  sku: true,
  priceCents: true,
  pasFeeCents: true,
  imageUrl: true,
  sortOrder: true,
  active: true,
  createdAt: true,
} as const;

/**
 * A retailer's products, in WATCH ORDER: oldest first.
 *
 * The order the export fills watchdog lists in. Oldest-first means a product added later
 * joins the end of the last list instead of shuffling every list along by one -- which would
 * rewrite all of them in the backup for the sake of one new line. It is NOT the order the
 * page shows a set in, which an admin arranges (groupBySet): arranging a set for members
 * leaves the backups alone.
 */
export async function getCatalog(
  siteKey: string,
  { includeRetired = false }: { includeRetired?: boolean } = {},
): Promise<CatalogProduct[]> {
  return prisma.dropProduct.findMany({
    where: { siteKey, ...(includeRetired ? {} : { active: true }) },
    orderBy: [{ createdAt: "asc" }, { sku: "asc" }],
    select: PRODUCT_SELECT,
  });
}

/** The sets' names in the order an admin arranged them. A set not named here is new. */
export async function getSetOrder(siteKey: string): Promise<string[]> {
  const rows = await prisma.dropSet.findMany({
    where: { siteKey },
    orderBy: { sortOrder: "asc" },
    select: { name: true },
  });
  return rows.map((row) => row.name);
}

/** One member's picks on a retailer, by product id. A product they haven't picked is absent. */
export async function getMemberChoices(
  discordUserId: string,
  siteKey: string,
): Promise<Record<string, Choice>> {
  const rows = await prisma.productSelection.findMany({
    where: { discordUserId, product: { siteKey } },
    select: { productId: true, allProfiles: true, profiles: { select: { profileId: true } } },
  });
  return Object.fromEntries(
    rows.map((row) => [
      row.productId,
      { all: row.allProfiles, profileIds: row.profiles.map((p) => p.profileId) },
    ]),
  );
}

/** A member's profiles on a retailer, for picking between. Name order, as everywhere else. */
export async function getPickableProfiles(
  discordUserId: string,
  siteKey: string,
): Promise<{ id: string; name: string; active: boolean }[]> {
  const profiles = await prisma.vaultProfile.findMany({
    where: { discordUserId, siteKey },
    select: { id: true, name: true, active: true },
  });
  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  return profiles.sort((a, b) => collator.compare(a.name, b.name));
}

async function selectionRows(where: {
  siteKey: string;
  discordUserIds?: string[];
}): Promise<SelectionRow[]> {
  const rows = await prisma.productSelection.findMany({
    where: {
      product: { siteKey: where.siteKey, active: true },
      ...(where.discordUserIds ? { discordUserId: { in: where.discordUserIds } } : {}),
    },
    select: {
      productId: true,
      discordUserId: true,
      allProfiles: true,
      profiles: { select: { profileId: true } },
    },
  });
  return rows.map((row) => ({
    productId: row.productId,
    discordUserId: row.discordUserId,
    allProfiles: row.allProfiles,
    profileIds: row.profiles.map((p) => p.profileId),
  }));
}

/**
 * How many members and ACTIVE profiles each product would run on, for the operator's view of
 * the page. Counted by the same rule the export builds tasks with, so the two never disagree.
 */
export async function getSelectionCounts(
  siteKey: string,
): Promise<Record<string, { members: number; profiles: number }>> {
  const [catalog, selections] = await Promise.all([
    getCatalog(siteKey),
    selectionRows({ siteKey }),
  ]);
  const members = [...new Set(selections.map((s) => s.discordUserId))];
  const profiles = await prisma.vaultProfile.findMany({
    where: { siteKey, active: true, discordUserId: { in: members } },
    select: { id: true, discordUserId: true },
  });
  const skus = skusByProfile(profiles, selections, catalog);

  const counts: Record<string, { members: number; profiles: number }> = {};
  const bySku = new Map(catalog.map((p) => [p.sku, p.id]));
  for (const product of catalog) counts[product.id] = { members: 0, profiles: 0 };
  const seen = new Map<string, Set<string>>();
  for (const profile of profiles) {
    for (const sku of skus.get(profile.id) ?? []) {
      const id = bySku.get(sku);
      if (!id) continue;
      counts[id].profiles += 1;
      const owners = seen.get(id) ?? new Set<string>();
      owners.add(profile.discordUserId);
      seen.set(id, owners);
    }
  }
  for (const [id, owners] of seen) counts[id].members = owners.size;
  return counts;
}

/**
 * The summary on Target Products (see countDrops), over every runner's members, with the
 * idle members' names put to them.
 */
export async function getDropStats(siteKey: string): Promise<DropStats> {
  const [catalog, selections, profiles] = await Promise.all([
    getCatalog(siteKey),
    selectionRows({ siteKey }),
    prisma.vaultProfile.findMany({
      where: { siteKey, active: true },
      select: { id: true, discordUserId: true },
    }),
  ]);
  const { stats, idleIds } = countDrops(catalog, selections, profiles);

  const names = await prisma.discordMember.findMany({
    where: { discordUserId: { in: idleIds } },
    select: { discordUserId: true, username: true, globalName: true },
  });
  const nameOf = new Map(names.map((m) => [m.discordUserId, m.globalName ?? m.username]));
  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  return {
    ...stats,
    idle: idleIds
      .map((id) => ({ discordUserId: id, name: nameOf.get(id) ?? id }))
      .sort((a, b) => collator.compare(a.name, b.name)),
  };
}

/**
 * The TCINs each of these profiles runs for, in watch order -- what the Shikari export puts
 * on their checkout tasks, and the union of which its watchdogs watch.
 */
export async function getSkusForProfiles(
  siteKey: string,
  profiles: { id: string; discordUserId: string }[],
): Promise<{ skus: Map<string, string[]>; catalog: CatalogProduct[] }> {
  const members = [...new Set(profiles.map((p) => p.discordUserId))];
  const [catalog, selections] = await Promise.all([
    getCatalog(siteKey),
    selectionRows({ siteKey, discordUserIds: members }),
  ]);
  return { skus: skusByProfile(profiles, selections, catalog), catalog };
}
