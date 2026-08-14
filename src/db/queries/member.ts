import "server-only";

import { prisma } from "@/db/client";
import { resolveSiteLogo } from "@/lib/site-logo";

/**
 * Queries backing the signed-in member dashboard.
 *
 * **Every function here takes `discordUserId` as its first argument, and callers must
 * pass the value returned by `requireMember()`** -- never a route param, search param,
 * or form field. That convention is the whole IDOR defence, so the id is a required
 * parameter rather than something read from a session inside these functions: it makes
 * a caller that forgot to authenticate a type error rather than a silent leak.
 *
 * Unlike the public feed there is no 30-minute delay and no anonymisation. This is the
 * member's own data.
 */

export type MemberCheckout = {
  id: string;
  occurredAt: Date;
  site: string | null;
  siteLogo: string | null;
  label: string;
  quantity: number;
  imageUrl: string | null;
  /** The checkout profile it landed on, so a member with several can tell them apart. */
  profileName: string | null;
};

export type MemberChargeSummary = {
  id: string;
  dropLabel: string;
  windowStart: Date;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  ogApplied: boolean;
  paidAt: Date | null;
  lineCount: number;
  unitCount: number;
};

export type MemberProfile = {
  profileKey: string;
  displayName: string;
  billable: boolean;
};

export type MemberDashboard = {
  unpaidTotalCents: number;
  unpaidCount: number;
  lifetimeCheckouts: number;
  lifetimeUnits: number;
  charges: MemberChargeSummary[];
  profiles: MemberProfile[];
  recentCheckouts: MemberCheckout[];
};

/**
 * Dry runs are excluded everywhere a charge is counted or listed.
 *
 * A dry run is a preview the operator did against real data; nobody was DMed and
 * nobody owes anything. Showing one as an outstanding balance would be telling a
 * member they owe money they were never asked for.
 */
const REAL_RUNS = { run: { dryRun: false } } as const;

const RECENT_CHECKOUT_LIMIT = 50;

export async function getMemberDashboard(discordUserId: string): Promise<MemberDashboard> {
  const [bills, profiles, checkoutTotals, recent] = await Promise.all([
    prisma.pasBill.findMany({
      where: { discordUserId, ...REAL_RUNS },
      orderBy: { run: { windowStart: "desc" } },
      select: {
        id: true,
        subtotalCents: true,
        discountCents: true,
        totalCents: true,
        ogApplied: true,
        paidAt: true,
        run: { select: { dropLabel: true, windowStart: true } },
        lines: { select: { qty: true } },
      },
    }),

    prisma.profile.findMany({
      where: { discordUserId },
      orderBy: { profileKey: "asc" },
      select: { profileKey: true, displayName: true, billable: true },
    }),

    prisma.checkout.aggregate({
      where: { profile: { discordUserId } },
      _count: { _all: true },
      _sum: { quantity: true },
    }),

    prisma.checkout.findMany({
      where: { profile: { discordUserId } },
      orderBy: { occurredAt: "desc" },
      take: RECENT_CHECKOUT_LIMIT,
      select: {
        id: true,
        occurredAt: true,
        site: true,
        quantity: true,
        productRaw: true,
        imageUrl: true,
        item: { select: { label: true, imageUrl: true } },
        profile: { select: { displayName: true } },
      },
    }),
  ]);

  const charges: MemberChargeSummary[] = bills.map((bill) => ({
    id: bill.id,
    dropLabel: bill.run.dropLabel,
    windowStart: bill.run.windowStart,
    subtotalCents: bill.subtotalCents,
    discountCents: bill.discountCents,
    totalCents: bill.totalCents,
    ogApplied: bill.ogApplied,
    paidAt: bill.paidAt,
    lineCount: bill.lines.length,
    unitCount: bill.lines.reduce((sum, line) => sum + line.qty, 0),
  }));

  const unpaid = charges.filter((charge) => charge.paidAt === null);

  return {
    unpaidTotalCents: unpaid.reduce((sum, charge) => sum + charge.totalCents, 0),
    unpaidCount: unpaid.length,
    lifetimeCheckouts: checkoutTotals._count._all,
    lifetimeUnits: checkoutTotals._sum.quantity ?? 0,
    charges,
    profiles,
    recentCheckouts: recent.map((row) => ({
      id: row.id,
      occurredAt: row.occurredAt,
      site: row.site,
      siteLogo: resolveSiteLogo(row.site),
      quantity: row.quantity,
      label: row.item?.label ?? row.productRaw ?? "an item",
      imageUrl: row.item?.imageUrl ?? row.imageUrl,
      profileName: row.profile?.displayName ?? null,
    })),
  };
}

export type MemberChargeDetail = {
  id: string;
  dropLabel: string;
  windowStart: Date;
  windowEnd: Date;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  ogApplied: boolean;
  paidAt: Date | null;
  /** The exact text the member received in Discord. */
  dmText: string | null;
  lines: { id: string; label: string; qty: number; feeCents: number; subtotalCents: number }[];
  payments: { id: string; amountCents: number; method: string | null; recordedAt: Date }[];
};

/**
 * One charge, or null.
 *
 * Both predicates are in the WHERE clause. Never fetch by id and compare ownership
 * afterwards -- the two-predicate form is what makes a guessed id indistinguishable
 * from a nonexistent one, and the page turns the null into a 404.
 *
 * Amounts come from the bill's own snapshot columns and `PasBillLine.feeCents`, never
 * from `Item.currentFeeCents`. Editing a fee in admin must never change what someone
 * was already charged, and this page is the record that settles a dispute months later.
 */
export async function getMemberCharge(
  discordUserId: string,
  chargeId: string,
): Promise<MemberChargeDetail | null> {
  const bill = await prisma.pasBill.findFirst({
    where: { id: chargeId, discordUserId, ...REAL_RUNS },
    select: {
      id: true,
      subtotalCents: true,
      discountCents: true,
      totalCents: true,
      ogApplied: true,
      paidAt: true,
      dmText: true,
      run: { select: { dropLabel: true, windowStart: true, windowEnd: true } },
      lines: {
        orderBy: { subtotalCents: "desc" },
        select: { id: true, label: true, qty: true, feeCents: true, subtotalCents: true },
      },
      payments: {
        orderBy: { recordedAt: "desc" },
        select: { id: true, amountCents: true, method: true, recordedAt: true },
      },
    },
  });
  if (!bill) return null;

  return {
    id: bill.id,
    dropLabel: bill.run.dropLabel,
    windowStart: bill.run.windowStart,
    windowEnd: bill.run.windowEnd,
    subtotalCents: bill.subtotalCents,
    discountCents: bill.discountCents,
    totalCents: bill.totalCents,
    ogApplied: bill.ogApplied,
    paidAt: bill.paidAt,
    dmText: bill.dmText,
    lines: bill.lines,
    payments: bill.payments,
  };
}
