import "server-only";

import { prisma } from "@/db/client";
import type { Prisma } from "@/generated/prisma/client";

/**
 * The operator's view of what is owed.
 *
 * Callers MUST have passed `requireAdmin()` first -- nothing here re-checks, matching
 * the split used by the vault queries: a query module that quietly enforced
 * authorization would make it tempting to skip the guard on the page.
 *
 * Dry runs are excluded everywhere, same as the member side. A dry run is a preview the
 * operator did against real data; nobody was DMed and nobody owes anything, so counting
 * one here would inflate the outstanding balance with money that was never asked for.
 *
 * Filtering and paging happen in SQL, not after the fetch. A charges list grows without
 * bound -- one drop is ~60 bills -- and "load everything then slice" is the version that
 * works for a year and then quietly starts timing out.
 */

const REAL_RUNS = { run: { dryRun: false } } as const;

export type ChargeFilter = "claimed" | "unpaid" | "paid" | "all";

/** Rows per page. Big enough that a normal drop fits on one. */
export const PAGE_SIZE = 50;

export type ChargeQuery = {
  filter: ChargeFilter;
  /** Matches the member's username or display name, case-insensitively. */
  search?: string;
  /** Inclusive bounds on the drop's window start, as YYYY-MM-DD. */
  from?: string;
  to?: string;
  page?: number;
};

export type AdminChargeRow = {
  id: string;
  discordUserId: string;
  username: string;
  displayName: string;
  dropLabel: string;
  windowStart: Date;
  totalCents: number;
  paidAt: Date | null;
  paidClaimedAt: Date | null;
  paidClaimedMethod: string | null;
  paidClaimedNote: string | null;
  markedPaidBy: string | null;
  lineCount: number;
};

export type AdminChargePage = {
  rows: AdminChargeRow[];
  /** Rows matching the filter, ignoring paging. */
  total: number;
  /** Sum of `totalCents` across the whole match, not just this page. */
  totalCents: number;
  page: number;
  pageCount: number;
};

export type AdminChargeTotals = {
  claimedCount: number;
  claimedCents: number;
  outstandingCount: number;
  outstandingCents: number;
  paidCount: number;
  paidCents: number;
};

const STATUS: Record<ChargeFilter, Prisma.PasBillWhereInput> = {
  claimed: { paidAt: null, paidClaimedAt: { not: null } },
  unpaid: { paidAt: null },
  paid: { paidAt: { not: null } },
  all: {},
};

/** End of the given day, so `to=2026-08-07` includes that day's drops. */
function endOfDay(date: string): Date {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed;
}

function buildWhere(query: ChargeQuery): Prisma.PasBillWhereInput {
  const windowStart: Prisma.DateTimeFilter = {};
  if (query.from) windowStart.gte = new Date(`${query.from}T00:00:00.000Z`);
  if (query.to) windowStart.lt = endOfDay(query.to);
  const hasDates = Object.keys(windowStart).length > 0;

  const search = query.search?.trim();

  return {
    ...STATUS[query.filter],
    run: { dryRun: false, ...(hasDates ? { windowStart } : {}) },
    ...(search
      ? {
          member: {
            OR: [
              { username: { contains: search, mode: "insensitive" } },
              { globalName: { contains: search, mode: "insensitive" } },
            ],
          },
        }
      : {}),
  };
}

/**
 * Sort order, per tab.
 *
 *   claimed  a queue: whoever has been waiting longest is dealt with first.
 *   paid     newest drop first. Ordering by when the button was clicked put a charge
 *            settled today above a whole newer drop, which reads as out of order.
 *   unpaid   claims first (oldest waiting), then newest drop. `nulls: "last"` does the
 *            grouping: every unclaimed row has a null `paidClaimedAt`, so they tie on
 *            that key and fall through to the drop date.
 *   all      unpaid before paid, then the same rules within each.
 *
 * The last key is always the drop date descending, which is what makes the grouping
 * readable -- within any status band, the newest drop is on top.
 */
function orderFor(filter: ChargeFilter): Prisma.PasBillOrderByWithRelationInput[] {
  const byDrop: Prisma.PasBillOrderByWithRelationInput[] = [
    { run: { windowStart: "desc" } },
    { createdAt: "desc" },
  ];

  switch (filter) {
    case "claimed":
      return [{ paidClaimedAt: "asc" }, ...byDrop];
    case "paid":
      return byDrop;
    case "unpaid":
      return [{ paidClaimedAt: { sort: "asc", nulls: "last" } }, ...byDrop];
    case "all":
      // Nulls first puts everything still owed above everything settled.
      return [
        { paidAt: { sort: "desc", nulls: "first" } },
        { paidClaimedAt: { sort: "asc", nulls: "last" } },
        ...byDrop,
      ];
  }
}

export async function getAdminCharges(query: ChargeQuery): Promise<AdminChargePage> {
  const where = buildWhere(query);
  const page = Math.max(1, query.page ?? 1);

  const [total, aggregate, bills] = await Promise.all([
    prisma.pasBill.count({ where }),
    prisma.pasBill.aggregate({ where, _sum: { totalCents: true } }),
    prisma.pasBill.findMany({
      where,
      select: {
        id: true,
        discordUserId: true,
        totalCents: true,
        paidAt: true,
        paidClaimedAt: true,
        paidClaimedMethod: true,
        paidClaimedNote: true,
        markedPaidBy: true,
        member: { select: { username: true, globalName: true } },
        run: { select: { dropLabel: true, windowStart: true } },
        _count: { select: { lines: true } },
      },
      orderBy: orderFor(query.filter),
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);

  return {
    rows: bills.map((b) => ({
      id: b.id,
      discordUserId: b.discordUserId,
      username: b.member.username,
      displayName: b.member.globalName ?? b.member.username,
      dropLabel: b.run.dropLabel,
      windowStart: b.run.windowStart,
      totalCents: b.totalCents,
      paidAt: b.paidAt,
      paidClaimedAt: b.paidClaimedAt,
      paidClaimedMethod: b.paidClaimedMethod,
      paidClaimedNote: b.paidClaimedNote,
      markedPaidBy: b.markedPaidBy,
      lineCount: b._count.lines,
    })),
    total,
    totalCents: aggregate._sum.totalCents ?? 0,
    page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
}

export async function getAdminChargeTotals(): Promise<AdminChargeTotals> {
  const [claimed, outstanding, paid] = await Promise.all([
    prisma.pasBill.aggregate({
      where: { ...REAL_RUNS, paidAt: null, paidClaimedAt: { not: null } },
      _count: { _all: true },
      _sum: { totalCents: true },
    }),
    prisma.pasBill.aggregate({
      where: { ...REAL_RUNS, paidAt: null },
      _count: { _all: true },
      _sum: { totalCents: true },
    }),
    prisma.pasBill.aggregate({
      where: { ...REAL_RUNS, paidAt: { not: null } },
      _count: { _all: true },
      _sum: { totalCents: true },
    }),
  ]);

  return {
    claimedCount: claimed._count._all,
    claimedCents: claimed._sum.totalCents ?? 0,
    outstandingCount: outstanding._count._all,
    outstandingCents: outstanding._sum.totalCents ?? 0,
    paidCount: paid._count._all,
    paidCents: paid._sum.totalCents ?? 0,
  };
}

/** Every drop that has produced a real bill, newest first, for the date presets. */
export async function getDropDates(): Promise<{ label: string; date: Date }[]> {
  const runs = await prisma.pasRun.findMany({
    where: { dryRun: false, bills: { some: {} } },
    select: { dropLabel: true, windowStart: true },
    orderBy: { windowStart: "desc" },
    take: 24,
  });
  return runs.map((r) => ({ label: r.dropLabel, date: r.windowStart }));
}

/**
 * How many claims are waiting on the operator, for the nav badge.
 *
 * Unlike the rest of this module, this one is called from a page guarded by
 * `requireMember()` rather than `requireAdmin()` -- the dashboard header renders it only
 * when `viewer.isAdmin`, which is re-derived per request from the env allowlist. It
 * returns a single integer and nothing member-identifying, so the blast radius of a
 * caller forgetting the check is a number, not a name.
 */
export async function getPendingConfirmationCount(): Promise<number> {
  return prisma.pasBill.count({
    where: { ...REAL_RUNS, paidAt: null, paidClaimedAt: { not: null } },
  });
}
