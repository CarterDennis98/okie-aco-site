import "server-only";

import { prisma } from "@/db/client";
import { resolveSiteLogo } from "@/lib/site-logo";

/**
 * Queries backing the public, unauthenticated home page.
 *
 * The privacy rules live HERE, not in the components, so a future page can't render
 * something sensitive by forgetting to filter:
 *
 *   - No member names, profile names, or Discord IDs are ever selected.
 *   - No fees or dollar amounts. That's the operator's pricing and members' spend.
 *   - The feed is delayed, so it isn't a free drop-alert for people who aren't paying.
 */

/** A real-time public feed would tell non-members exactly when a drop went live. */
const FEED_DELAY_MS = 30 * 60 * 1000;

const RECENT_WINDOW_DAYS = 30;

export type StatsRange = "recent" | "all";

export type PublicCheckout = {
  id: string;
  occurredAt: Date;
  site: string | null;
  /** Resolved server-side; see resolveSiteLogo. */
  siteLogo: string | null;
  label: string;
  quantity: number;
  imageUrl: string | null;
};

export type TopProduct = {
  id: string;
  label: string;
  source: string | null;
  units: number;
  imageUrl: string | null;
};

export type DayBucket = { date: string; units: number };

export type Drop = {
  id: string;
  /** Retailer. A time cluster spanning two sites becomes one card per site. */
  site: string | null;
  /** Resolved here rather than in the chip: that component renders inside the
   *  client-side carousel and must not touch the filesystem. Null until a logo file
   *  is dropped into public/sites/, at which point the chip switches automatically. */
  siteLogo: string | null;
  startedAt: Date;
  endedAt: Date;
  checkouts: number;
  units: number;
  members: number;
  /** Up to TOP_ITEMS_PER_DROP, biggest first. */
  topItems: TopProduct[];
  /** How many distinct products didn't make the top list. */
  otherItems: number;
};

export type RangeStats = {
  range: StatsRange;
  windowDays: number | null;
  checkouts: number;
  units: number;
  members: number;
  topProducts: TopProduct[];
  byDay: DayBucket[];
};

/** Excludes opted-out members. See getPublicFeed for why this is phrased as NOT(). */
function visibilityFilter() {
  return { NOT: { profile: { member: { user: { hideFromPublicFeed: true } } } } };
}

/**
 * Counts distinct PEOPLE, not distinct profiles.
 *
 * The `" - N"` suffix case (`carter` / `carter - 2`) is already collapsed upstream by
 * profileKey normalisation, so it never double-counted. What does double-count is one
 * person holding two differently-named profiles: those are separate profileKeys that
 * map to the same Discord user.
 *
 * Mapped profiles therefore collapse onto their user id. Unmapped ones have no user to
 * collapse onto, so each is counted as one person -- a deliberate over-estimate, since
 * assuming they're duplicates would under-count instead. As more profiles get mapped in
 * the admin UI this number self-corrects downward.
 */
async function countDistinctMembers(profileKeys: string[]): Promise<number> {
  const keys = [...new Set(profileKeys)];
  if (keys.length === 0) return 0;

  const profiles = await prisma.profile.findMany({
    where: { profileKey: { in: keys } },
    select: { profileKey: true, discordUserId: true },
  });
  const userByKey = new Map(profiles.map((p) => [p.profileKey, p.discordUserId]));

  const identities = new Set<string>();
  for (const key of keys) {
    const userId = userByKey.get(key);
    identities.add(userId ? `user:${userId}` : `profile:${key}`);
  }
  return identities.size;
}

function rangeFilter(range: StatsRange) {
  const before = new Date(Date.now() - FEED_DELAY_MS);
  if (range === "all") return { occurredAt: { lt: before } };
  return {
    occurredAt: { gte: new Date(Date.now() - RECENT_WINDOW_DAYS * 86_400_000), lt: before },
  };
}

/**
 * Recent checkouts, anonymized. Deliberately selects no member-identifying column --
 * not even a profile key -- so there is nothing to leak downstream.
 */
export async function getPublicFeed(limit = 250): Promise<PublicCheckout[]> {
  const rows = await prisma.checkout.findMany({
    where: {
      occurredAt: { lt: new Date(Date.now() - FEED_DELAY_MS) },
      // Exclude opted-out members. Phrased as NOT(opted out) rather than
      // requires(opted in) on purpose: a User row only exists once someone has signed
      // in, so the positive form would hide every checkout by a member who never
      // visited the site -- which is most of them.
      ...visibilityFilter(),
    },
    orderBy: { occurredAt: "desc" },
    take: limit,
    select: {
      id: true,
      occurredAt: true,
      site: true,
      quantity: true,
      productRaw: true,
      imageUrl: true,
      item: { select: { label: true, imageUrl: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    occurredAt: row.occurredAt,
    site: row.site,
    siteLogo: resolveSiteLogo(row.site),
    quantity: row.quantity,
    label: row.item?.label ?? row.productRaw ?? "an item",
    // The item's image is canonical; the checkout's own is the fallback for rows
    // ingested before an item was matched.
    imageUrl: row.item?.imageUrl ?? row.imageUrl,
  }));
}

/** Everything the stats panel needs for one range, in one round trip per range. */
export async function getRangeStats(range: StatsRange): Promise<RangeStats> {
  const where = { ...rangeFilter(range), ...visibilityFilter() };

  const [aggregate, distinctProfiles, grouped, days] = await Promise.all([
    prisma.checkout.aggregate({ where, _count: { _all: true }, _sum: { quantity: true } }),
    // Counting distinct profiles, not selecting them.
    prisma.checkout.findMany({
      where: { ...where, profileKey: { not: null } },
      distinct: ["profileKey"],
      select: { profileKey: true },
    }),
    prisma.checkout.groupBy({
      by: ["itemId"],
      where: { ...where, itemId: { not: null } },
      _sum: { quantity: true },
      orderBy: { _sum: { quantity: "desc" } },
      take: 6,
    }),
    prisma.checkout.findMany({ where, select: { occurredAt: true, quantity: true } }),
  ]);

  const items = await prisma.item.findMany({
    where: { id: { in: grouped.map((g) => g.itemId!).filter(Boolean) } },
    select: { id: true, label: true, source: true, imageUrl: true },
  });
  const byId = new Map(items.map((i) => [i.id, i]));

  const topProducts = grouped
    .map((g) => {
      const item = byId.get(g.itemId!);
      if (!item) return null;
      return { ...item, units: g._sum.quantity ?? 0 };
    })
    .filter((x): x is TopProduct => x !== null);

  // Bucketed in JS rather than SQL: the row count is small and this keeps the
  // date grouping in one timezone-explicit place instead of a raw query.
  const buckets = new Map<string, number>();
  for (const row of days) {
    const key = row.occurredAt.toISOString().slice(0, 10);
    buckets.set(key, (buckets.get(key) ?? 0) + row.quantity);
  }
  const byDay = [...buckets.entries()]
    .map(([date, units]) => ({ date, units }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const members = await countDistinctMembers(
    distinctProfiles.map((p) => p.profileKey).filter((k): k is string => k !== null),
  );

  return {
    range,
    windowDays: range === "recent" ? RECENT_WINDOW_DAYS : null,
    checkouts: aggregate._count._all,
    units: aggregate._sum.quantity ?? 0,
    members,
    topProducts,
    byDay,
  };
}

/**
 * A "drop" is a burst of checkouts, not a calendar day. Consecutive checkouts closer
 * together than this belong to the same drop, so one that starts at 11pm and runs past
 * midnight stays a single drop, and two separate drops on the same day stay separate.
 */
const DROP_GAP_MS = 6 * 60 * 60 * 1000;
const TOP_ITEMS_PER_DROP = 5;
/** Enough to page through in the carousel without loading the whole history. */
const MAX_DROPS = 12;

/**
 * Clusters recent checkouts into drops, newest first.
 *
 * Clustered in JS rather than SQL: gap-based sessionization is awkward as a window
 * function and the row counts here are small (~150 per drop). If all-time ever grows
 * past a few tens of thousands of rows this should move to a date-bounded query or a
 * materialized drops table.
 */
export async function getRecentDrops(range: StatsRange, limit = MAX_DROPS): Promise<Drop[]> {
  const rows = await prisma.checkout.findMany({
    where: { ...rangeFilter(range), ...visibilityFilter() },
    orderBy: { occurredAt: "desc" },
    // profileKey is read for distinct-member counting and then discarded -- it is
    // never returned to the caller.
    select: { occurredAt: true, quantity: true, itemId: true, profileKey: true, site: true },
  });
  if (rows.length === 0) return [];

  type Row = (typeof rows)[number];

  // 1. Cluster by time gap. Newest-first, so a gap means the older side starts a
  //    new drop.
  const clusters: Row[][] = [];
  let current: Row[] = [];
  for (const row of rows) {
    const previous = current[current.length - 1];
    if (previous && previous.occurredAt.getTime() - row.occurredAt.getTime() > DROP_GAP_MS) {
      clusters.push(current);
      current = [];
    }
    current.push(row);
  }
  if (current.length) clusters.push(current);

  // 2. Split each cluster by retailer -- a night that hit both Target and Walmart
  //    reads as two drops, not one mixed card.
  const split: { site: string | null; rows: Row[] }[] = [];
  for (const cluster of clusters) {
    const bySite = new Map<string, Row[]>();
    for (const row of cluster) {
      const key = row.site ?? "";
      const list = bySite.get(key);
      if (list) list.push(row);
      else bySite.set(key, [row]);
    }
    for (const [site, siteRows] of bySite) split.push({ site: site || null, rows: siteRows });
  }

  const wanted = split
    .sort((a, b) => b.rows[0].occurredAt.getTime() - a.rows[0].occurredAt.getTime())
    .slice(0, limit);

  const itemIds = [...new Set(wanted.flatMap((d) => d.rows.map((r) => r.itemId).filter(Boolean)))];
  const items = await prisma.item.findMany({
    where: { id: { in: itemIds as string[] } },
    select: { id: true, label: true, source: true, imageUrl: true },
  });
  const byId = new Map(items.map((i) => [i.id, i]));

  // One profile lookup for every drop, then the same identity rule per drop.
  const allKeys = wanted.flatMap(
    (d) => d.rows.map((r) => r.profileKey).filter(Boolean) as string[],
  );
  const profileRows = await prisma.profile.findMany({
    where: { profileKey: { in: [...new Set(allKeys)] } },
    select: { profileKey: true, discordUserId: true },
  });
  const userByKey = new Map(profileRows.map((p) => [p.profileKey, p.discordUserId]));

  return wanted.map(({ site, rows: cluster }) => {
    const unitsByItem = new Map<string, number>();
    const members = new Set<string>();
    let units = 0;

    for (const row of cluster) {
      units += row.quantity;
      if (row.profileKey) {
        const userId = userByKey.get(row.profileKey);
        // Collapse a person's several profiles onto one identity.
        members.add(userId ? `user:${userId}` : `profile:${row.profileKey}`);
      }
      if (row.itemId)
        unitsByItem.set(row.itemId, (unitsByItem.get(row.itemId) ?? 0) + row.quantity);
    }

    const ranked = [...unitsByItem.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([itemId, itemUnits]) => {
        const item = byId.get(itemId);
        return item ? { ...item, units: itemUnits } : null;
      })
      .filter((x): x is TopProduct => x !== null);

    // cluster is newest-first
    const endedAt = cluster[0].occurredAt;
    const startedAt = cluster[cluster.length - 1].occurredAt;

    return {
      id: `${startedAt.getTime()}-${site ?? "unknown"}`,
      site,
      siteLogo: resolveSiteLogo(site),
      startedAt,
      endedAt,
      checkouts: cluster.length,
      units,
      members: members.size,
      topItems: ranked.slice(0, TOP_ITEMS_PER_DROP),
      otherItems: Math.max(0, ranked.length - TOP_ITEMS_PER_DROP),
    };
  });
}

export async function getApprovedTestimonials(limit = 6) {
  return prisma.testimonial.findMany({
    where: { approved: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
    take: limit,
    select: { id: true, body: true, attribution: true },
  });
}
