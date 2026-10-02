import "server-only";

import { prisma } from "@/db/client";
import { getMemberAcoCredit } from "@/db/queries/aco-credit";
import { productLabel } from "@/lib/normalize";
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
  /**
   * The checkout profile it landed on, so a member with several can tell them apart.
   *
   * Read from the CHECKOUT, not from the profile row it joins to. `profiles.profile_key`
   * is the name with its " - N" suffix stripped, so every one of a member's numbered
   * profiles joins to the same row -- and that row's `display_name` is whichever raw name
   * happened to create it. Rendering it here told a member with four Target profiles that
   * all four checkouts were on the same one.
   */
  profileName: string | null;
};

export type MemberChargeSummary = {
  id: string;
  /** Who they pay for this one -- the operator, or whoever runs that retailer's bot. */
  payeeId: string;
  dropLabel: string;
  windowStart: Date;
  subtotalCents: number;
  discountCents: number;
  /** ACO credit this charge spent. See PasBill.creditCents. */
  creditCents: number;
  totalCents: number;
  /** Recorded as received so far. Less than the total means part-paid, not paid. */
  paidCents: number;
  ogApplied: boolean;
  paidAt: Date | null;
  /** The member said they sent it. Not the same as the operator having seen it land. */
  paidClaimedAt: Date | null;
  /** How much they said they sent, when it was less than the whole balance. */
  paidClaimedCents: number | null;
  lineCount: number;
  unitCount: number;
};

export type MemberDashboard = {
  unpaidTotalCents: number;
  unpaidCount: number;
  /**
   * What is still owed, per person it is owed to, largest first. A member who owes the
   * operator AND Chess has two people to pay, and a single total with one payment button
   * would send all of it to the operator.
   */
  owedByPayee: { payeeId: string; cents: number; count: number }[];
  lifetimeCheckouts: number;
  lifetimeUnits: number;
  /**
   * ACO credit they hold: comes off their next Okie ACO fees on its own. The note is the
   * reason the operator gave for the latest credit, when they gave one.
   */
  acoCredit: { balanceCents: number; lastNote: string | null };
  charges: MemberChargeSummary[];
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

/**
 * Matches the public feed's cap, and for the same reason: a scroll pane can hold this
 * many rows without the page becoming tens of thousands of pixels tall.
 *
 * The dashboard states when it is showing a subset. A list that silently stops at its
 * limit reads as "this is everything you have", which for the operator would mean 349
 * checkouts presented as 50.
 */
const RECENT_CHECKOUT_LIMIT = 250;

export async function getMemberDashboard(discordUserId: string): Promise<MemberDashboard> {
  const [bills, checkoutTotals, recent, acoCredit] = await Promise.all([
    prisma.pasBill.findMany({
      where: { discordUserId, ...REAL_RUNS },
      orderBy: { run: { windowStart: "desc" } },
      select: {
        id: true,
        payeeId: true,
        subtotalCents: true,
        discountCents: true,
        creditCents: true,
        totalCents: true,
        ogApplied: true,
        paidAt: true,
        paidCents: true,
        paidClaimedAt: true,
        paidClaimedCents: true,
        run: { select: { dropLabel: true, windowStart: true } },
        lines: { select: { qty: true } },
      },
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
        profileRaw: true,
        item: { select: { label: true, imageUrl: true } },
        profile: { select: { displayName: true } },
      },
    }),

    getMemberAcoCredit(discordUserId),
  ]);

  const charges: MemberChargeSummary[] = bills.map((bill) => ({
    id: bill.id,
    payeeId: bill.payeeId,
    dropLabel: bill.run.dropLabel,
    windowStart: bill.run.windowStart,
    subtotalCents: bill.subtotalCents,
    discountCents: bill.discountCents,
    creditCents: bill.creditCents,
    totalCents: bill.totalCents,
    ogApplied: bill.ogApplied,
    paidCents: bill.paidCents,
    paidAt: bill.paidAt,
    paidClaimedAt: bill.paidClaimedAt,
    paidClaimedCents: bill.paidClaimedCents,
    lineCount: bill.lines.length,
    unitCount: bill.lines.reduce((sum, line) => sum + line.qty, 0),
  }));

  // paidAt is still the test for "does this owe anything", by the invariant in the
  // schema -- it is stamped exactly when paid_cents covers the bill.
  const unpaid = charges.filter((charge) => charge.paidAt === null);

  // What is LEFT, not the original totals: a member who has paid half of a $42 charge
  // owes $21, and showing $42 would be asking for money already received.
  const left = (charge: MemberChargeSummary) => Math.max(0, charge.totalCents - charge.paidCents);

  const owedByPayee = [...Map.groupBy(unpaid, (charge) => charge.payeeId)]
    .map(([payeeId, list]) => ({
      payeeId,
      cents: list.reduce((sum, charge) => sum + left(charge), 0),
      count: list.length,
    }))
    .sort((a, b) => b.cents - a.cents);

  return {
    unpaidTotalCents: unpaid.reduce((sum, charge) => sum + left(charge), 0),
    unpaidCount: unpaid.length,
    owedByPayee,
    lifetimeCheckouts: checkoutTotals._count._all,
    lifetimeUnits: checkoutTotals._sum.quantity ?? 0,
    acoCredit,
    charges,
    recentCheckouts: recent.map((row) => ({
      id: row.id,
      occurredAt: row.occurredAt,
      site: row.site,
      siteLogo: resolveSiteLogo(row.site),
      quantity: row.quantity,
      label: productLabel(row.item?.label ?? row.productRaw ?? "an item"),
      imageUrl: row.item?.imageUrl ?? row.imageUrl,
      // Falls back to the joined row only for checkouts ingested before profileRaw was
      // recorded; those are the ones with nothing more precise to show.
      profileName: row.profileRaw ?? row.profile?.displayName ?? null,
    })),
  };
}

export type MemberChargeLine = {
  id: string;
  label: string;
  qty: number;
  feeCents: number;
  subtotalCents: number;
  imageUrl: string | null;
};

export type MemberChargeDetail = {
  id: string;
  /** Who they pay for this charge. See lib/billing/payees.ts. */
  payeeId: string;
  dropLabel: string;
  windowStart: Date;
  windowEnd: Date;
  subtotalCents: number;
  discountCents: number;
  /** ACO credit this charge spent. See PasBill.creditCents. */
  creditCents: number;
  totalCents: number;
  ogApplied: boolean;
  /** Recorded as received so far. Less than the total means part-paid, not paid. */
  paidCents: number;
  paidAt: Date | null;
  paidClaimedAt: Date | null;
  paidClaimedCents: number | null;
  paidClaimedMethod: string | null;
  paidClaimedNote: string | null;
  /** Retailers this charge's products came from, for the chips. Usually one. */
  sites: { site: string; logo: string | null }[];
  lines: MemberChargeLine[];
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
      payeeId: true,
      subtotalCents: true,
      discountCents: true,
      creditCents: true,
      totalCents: true,
      ogApplied: true,
      paidAt: true,
      paidCents: true,
      paidClaimedAt: true,
      paidClaimedCents: true,
      paidClaimedMethod: true,
      paidClaimedNote: true,
      // dmText is deliberately NOT selected. The column still stores the exact message
      // as the dispute record, but the member's own page doesn't paste it back at them.
      run: { select: { dropLabel: true, windowStart: true, windowEnd: true } },
      lines: {
        orderBy: { subtotalCents: "desc" },
        select: {
          id: true,
          label: true,
          qty: true,
          feeCents: true,
          subtotalCents: true,
          // Art and retailer come from the item; the LINE keeps its own label and fee,
          // so a later rename or fee edit still can't alter what was charged.
          item: { select: { imageUrl: true, source: true } },
        },
      },
      payments: {
        orderBy: { recordedAt: "desc" },
        select: { id: true, amountCents: true, method: true, recordedAt: true },
      },
    },
  });
  if (!bill) return null;

  // Distinct retailers across the charge's products, in first-seen order. A drop that
  // spanned two stores yields two chips; the common case is one.
  const sites = [
    ...new Set(bill.lines.map((line) => line.item?.source).filter((s): s is string => Boolean(s))),
  ].map((site) => ({ site, logo: resolveSiteLogo(site) }));

  return {
    id: bill.id,
    payeeId: bill.payeeId,
    dropLabel: bill.run.dropLabel,
    windowStart: bill.run.windowStart,
    windowEnd: bill.run.windowEnd,
    subtotalCents: bill.subtotalCents,
    discountCents: bill.discountCents,
    creditCents: bill.creditCents,
    totalCents: bill.totalCents,
    ogApplied: bill.ogApplied,
    paidCents: bill.paidCents,
    paidAt: bill.paidAt,
    paidClaimedAt: bill.paidClaimedAt,
    paidClaimedCents: bill.paidClaimedCents,
    paidClaimedMethod: bill.paidClaimedMethod,
    paidClaimedNote: bill.paidClaimedNote,
    sites,
    lines: bill.lines.map((line) => ({
      id: line.id,
      // The stored label is left alone -- it is the record of what was billed -- and read
      // through the same tidying as everything else. See productLabel.
      label: productLabel(line.label),
      qty: line.qty,
      feeCents: line.feeCents,
      subtotalCents: line.subtotalCents,
      imageUrl: line.item?.imageUrl ?? null,
    })),
    payments: bill.payments,
  };
}
