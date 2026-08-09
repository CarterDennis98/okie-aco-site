import "server-only";

import { prisma } from "@/db/client";

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

const STATS_WINDOW_DAYS = 30;

export type PublicCheckout = {
  id: string;
  occurredAt: Date;
  site: string | null;
  label: string;
  quantity: number;
};

export type PublicStats = {
  checkouts: number;
  units: number;
  membersServed: number;
  windowDays: number;
};

/**
 * Recent checkouts, anonymized. Deliberately selects no member-identifying column --
 * not even a profile key -- so there is nothing to leak downstream.
 */
export async function getPublicFeed(limit = 12): Promise<PublicCheckout[]> {
  const rows = await prisma.checkout.findMany({
    where: {
      occurredAt: { lt: new Date(Date.now() - FEED_DELAY_MS) },
      // Exclude opted-out members. Phrased as NOT(opted out) rather than
      // requires(opted in) on purpose: a User row only exists once someone has signed
      // in, so the positive form would hide every checkout by a member who never
      // visited the site -- which is most of them.
      NOT: { profile: { member: { user: { hideFromPublicFeed: true } } } },
    },
    orderBy: { occurredAt: "desc" },
    take: limit,
    select: {
      id: true,
      occurredAt: true,
      site: true,
      quantity: true,
      productRaw: true,
      item: { select: { label: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    occurredAt: row.occurredAt,
    site: row.site,
    quantity: row.quantity,
    label: row.item?.label ?? row.productRaw ?? "an item",
  }));
}

/**
 * Headline counters. These are the actual social proof -- volume and recency are what
 * impress a prospective member, not knowing whose handle bought what.
 */
export async function getPublicStats(): Promise<PublicStats> {
  const since = new Date(Date.now() - STATS_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const where = { occurredAt: { gte: since, lt: new Date(Date.now() - FEED_DELAY_MS) } };

  const [aggregate, distinctProfiles] = await Promise.all([
    prisma.checkout.aggregate({ where, _count: { _all: true }, _sum: { quantity: true } }),
    // Counting distinct profiles, not selecting them.
    prisma.checkout.findMany({
      where: { ...where, profileKey: { not: null } },
      distinct: ["profileKey"],
      select: { profileKey: true },
    }),
  ]);

  return {
    checkouts: aggregate._count._all,
    units: aggregate._sum.quantity ?? 0,
    membersServed: distinctProfiles.length,
    windowDays: STATS_WINDOW_DAYS,
  };
}

export async function getApprovedTestimonials(limit = 6) {
  return prisma.testimonial.findMany({
    where: { approved: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
    take: limit,
    select: { id: true, body: true, attribution: true },
  });
}

/** Products seen recently, for a "what we hit" strip. No fees, no quantities per member. */
export async function getRecentProducts(limit = 6) {
  const since = new Date(Date.now() - STATS_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const grouped = await prisma.checkout.groupBy({
    by: ["itemId"],
    where: { occurredAt: { gte: since }, itemId: { not: null } },
    _sum: { quantity: true },
    orderBy: { _sum: { quantity: "desc" } },
    take: limit,
  });

  const items = await prisma.item.findMany({
    where: { id: { in: grouped.map((g) => g.itemId!).filter(Boolean) } },
    select: { id: true, label: true, source: true },
  });
  const byId = new Map(items.map((i) => [i.id, i]));

  return grouped
    .map((g) => {
      const item = byId.get(g.itemId!);
      if (!item) return null;
      return { id: item.id, label: item.label, source: item.source, units: g._sum.quantity ?? 0 };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}
