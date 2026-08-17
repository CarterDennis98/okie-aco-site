import "server-only";

import { prisma } from "@/db/client";

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
 */

const REAL_RUNS = { run: { dryRun: false } } as const;

export type ChargeFilter = "claimed" | "unpaid" | "paid" | "all";

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

export type AdminChargeTotals = {
  /** Claimed by a member, not yet confirmed. The queue that needs working. */
  claimedCount: number;
  claimedCents: number;
  /** Everything still unpaid, claimed or not. */
  outstandingCount: number;
  outstandingCents: number;
  paidCount: number;
  paidCents: number;
};

const WHERE: Record<ChargeFilter, object> = {
  // Oldest claim first: someone who paid two weeks ago should not be behind someone
  // who paid this morning.
  claimed: { paidAt: null, paidClaimedAt: { not: null } },
  unpaid: { paidAt: null },
  paid: { paidAt: { not: null } },
  all: {},
};

export async function getAdminCharges(filter: ChargeFilter): Promise<AdminChargeRow[]> {
  const bills = await prisma.pasBill.findMany({
    where: { ...REAL_RUNS, ...WHERE[filter] },
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
    orderBy:
      filter === "claimed"
        ? [{ paidClaimedAt: "asc" }]
        : filter === "paid"
          ? [{ paidAt: "desc" }]
          : [{ paidClaimedAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
  });

  return bills.map((b) => ({
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
  }));
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
