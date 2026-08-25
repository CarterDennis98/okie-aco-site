import "server-only";

import { prisma } from "@/db/client";
import { resolveSiteLogo } from "@/lib/site-logo";

/**
 * Checkouts grouped by drop, then by the profile they landed on.
 *
 * TWO ENTRY POINTS, TWO GUARDS, and they live together on purpose: the member's own
 * per-drop view and the operator's per-charge dropdown are the same shape, and building
 * them separately is how the two would start disagreeing about what a drop contained.
 *
 *   - `getMemberDropCheckouts` takes `discordUserId` as its first argument, and callers
 *     MUST pass the value returned by `requireMember()` -- never a route or search param.
 *     Same convention as db/queries/member.ts, for the same reason.
 *   - `getBillCheckouts` is ADMIN-ONLY: callers must have passed `requireAdmin()` first.
 *     It takes a bill id and reads whoever that bill belongs to, which is exactly the
 *     thing a member must never be able to do. Nothing here re-checks -- matching the
 *     split used by the other admin query modules.
 *
 * Dry runs are excluded, like everywhere a drop is counted: nobody was billed for one, so
 * presenting it as a drop would invent an event.
 */

export type DropCheckout = {
  id: string;
  occurredAt: Date;
  site: string | null;
  siteLogo: string | null;
  label: string;
  quantity: number;
  imageUrl: string | null;
};

export type ProfileCheckouts = {
  /**
   * The profile as the CHECKOUT recorded it, suffix and all.
   *
   * Read from `profile_raw`, not from the joined profile row: `profiles.profile_key` has the
   * " - N" stripped, so every numbered profile joins to one row whose display name is
   * whichever raw name happened to create it. Grouping on that told a member with four
   * Target profiles that all four checkouts were on the same one.
   */
  profileName: string;
  checkoutCount: number;
  unitCount: number;
  checkouts: DropCheckout[];
};

export type DropGroup = {
  /** The billing run this window came from. Null for the not-yet-billed group. */
  runId: string | null;
  dropLabel: string;
  windowStart: Date;
  windowEnd: Date;
  checkoutCount: number;
  unitCount: number;
  profiles: ProfileCheckouts[];
};

export type MemberDropCheckouts = {
  drops: DropGroup[];
  checkoutCount: number;
  /** True when the cap below trimmed the oldest rows, so the UI can say so. */
  truncated: boolean;
};

/** How many recent drops to look back over. Eight is roughly a season of drops. */
const DROP_LIMIT = 8;

/**
 * Ceiling on checkouts pulled for the per-drop view.
 *
 * Ordered newest-first, so the cap trims the OLDEST -- which is why the result says it was
 * capped rather than letting an operator with 600 checkouts read the oldest drop as empty.
 */
const CHECKOUT_LIMIT = 600;

/** Ceiling per charge. One member's checkouts inside a single drop window. */
const PER_BILL_LIMIT = 400;

const CHECKOUT_SELECT = {
  id: true,
  occurredAt: true,
  site: true,
  quantity: true,
  productRaw: true,
  imageUrl: true,
  profileRaw: true,
  item: { select: { label: true, imageUrl: true } },
  profile: { select: { displayName: true } },
} as const;

type CheckoutRow = {
  id: string;
  occurredAt: Date;
  site: string | null;
  quantity: number;
  productRaw: string | null;
  imageUrl: string | null;
  profileRaw: string | null;
  item: { label: string; imageUrl: string | null } | null;
  profile: { displayName: string } | null;
};

function toCheckout(row: CheckoutRow): DropCheckout {
  return {
    id: row.id,
    occurredAt: row.occurredAt,
    site: row.site,
    siteLogo: resolveSiteLogo(row.site),
    quantity: row.quantity,
    label: row.item?.label ?? row.productRaw ?? "an item",
    imageUrl: row.item?.imageUrl ?? row.imageUrl,
  };
}

/**
 * Group one drop's checkouts by profile.
 *
 * Profiles sort by unit count descending -- the profile that did the work goes first, which
 * is the order somebody reads this list looking for. Ties fall back to the name so the
 * order is stable between renders.
 */
function groupByProfile(rows: CheckoutRow[]): ProfileCheckouts[] {
  const byProfile = new Map<string, CheckoutRow[]>();
  for (const row of rows) {
    // Only for checkouts ingested before profileRaw was recorded, and finally for the ones
    // the parser flagged as having no profile at all -- those are real and must not vanish
    // into a group that silently drops them.
    const name = row.profileRaw ?? row.profile?.displayName ?? "No profile recorded";
    byProfile.set(name, [...(byProfile.get(name) ?? []), row]);
  }

  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  return [...byProfile.entries()]
    .map(([profileName, list]) => ({
      profileName,
      checkoutCount: list.length,
      unitCount: list.reduce((sum, row) => sum + row.quantity, 0),
      checkouts: list.map(toCheckout),
    }))
    .sort((a, b) => b.unitCount - a.unitCount || collator.compare(a.profileName, b.profileName));
}

function summarize(
  runId: string | null,
  dropLabel: string,
  windowStart: Date,
  windowEnd: Date,
  rows: CheckoutRow[],
): DropGroup {
  return {
    runId,
    dropLabel,
    windowStart,
    windowEnd,
    checkoutCount: rows.length,
    unitCount: rows.reduce((sum, row) => sum + row.quantity, 0),
    profiles: groupByProfile(rows),
  };
}

/**
 * One person's own checkouts, split by drop.
 *
 * Built for the operator, who has house profiles and therefore no bills: the charges list
 * is how everybody else sees "what did I get in that drop", and with nothing billed it was
 * the one question the dashboard could not answer for them. Members see the same shape on
 * their charge pages, which is why this reuses the drop windows rather than inventing its
 * own grouping.
 *
 * A checkout inside NO run window still appears, under its own group. Drops are defined by
 * the windows the operator billed over, so a checkout after the last run -- or in the gap
 * between two -- is genuinely "not in a billed drop", and dropping it to keep the grouping
 * tidy would quietly lose rows.
 */
export async function getMemberDropCheckouts(discordUserId: string): Promise<MemberDropCheckouts> {
  const runs = await prisma.pasRun.findMany({
    where: { dryRun: false },
    orderBy: { windowStart: "desc" },
    take: DROP_LIMIT,
    select: { id: true, dropLabel: true, windowStart: true, windowEnd: true },
  });

  // Everything since the oldest window we are showing. With no runs at all there is no
  // lower bound to apply, and the cap alone decides how far back it reaches.
  const since = runs.length > 0 ? runs[runs.length - 1].windowStart : undefined;

  const rows = await prisma.checkout.findMany({
    where: {
      profile: { discordUserId },
      ...(since ? { occurredAt: { gte: since } } : {}),
    },
    orderBy: { occurredAt: "desc" },
    take: CHECKOUT_LIMIT,
    select: CHECKOUT_SELECT,
  });

  const unassigned: CheckoutRow[] = [];
  const byRun = new Map<string, CheckoutRow[]>();

  for (const row of rows) {
    // First window that contains it. Windows are billed sequentially and don't overlap in
    // practice; if two ever did, the newer run wins because `runs` is newest-first.
    const run = runs.find((r) => row.occurredAt >= r.windowStart && row.occurredAt <= r.windowEnd);
    if (!run) {
      unassigned.push(row);
      continue;
    }
    byRun.set(run.id, [...(byRun.get(run.id) ?? []), row]);
  }

  const drops: DropGroup[] = [];

  for (const run of runs) {
    const list = byRun.get(run.id);
    // Drops this person sat out are skipped rather than listed as empty: eight "0
    // checkouts" rows push the drops that matter off the screen.
    if (!list || list.length === 0) continue;
    drops.push(summarize(run.id, run.dropLabel, run.windowStart, run.windowEnd, list));
  }

  if (unassigned.length > 0) {
    // LAST, below every billed drop, even though it holds the newest rows. It is not a
    // drop -- it is the leftovers from between them -- and sitting at the top it pushed
    // the actual drops down and read as the most recent one. The list is scanned for
    // "what did I get on drop night", so the drops own the top of it.
    const dates = unassigned.map((row) => row.occurredAt.getTime());
    drops.push(
      summarize(
        null,
        "Not in a billed drop",
        new Date(Math.min(...dates)),
        new Date(Math.max(...dates)),
        unassigned,
      ),
    );
  }

  return {
    drops,
    checkoutCount: rows.length,
    truncated: rows.length === CHECKOUT_LIMIT,
  };
}

export type BillCheckouts = DropGroup & {
  /** True when the cap trimmed rows off this window. */
  truncated: boolean;
};

/**
 * What the member on this charge actually checked out during its drop window.
 *
 * ADMIN ONLY -- see the module header. The window comes from the bill's own run, so this
 * answers "what did they get for what I am billing them", which the bill lines alone don't:
 * lines are per PRODUCT, and the question being asked is per PROFILE.
 *
 * Deliberately NOT derived from `pas_bill_lines`. Those are the snapshot of what was
 * charged; these are the checkouts as ingested. Reading the second from the first would
 * make a fee edit look like a different set of orders.
 */
export async function getBillCheckouts(billId: string): Promise<BillCheckouts | null> {
  const bill = await prisma.pasBill.findFirst({
    where: { id: billId, run: { dryRun: false } },
    select: {
      discordUserId: true,
      run: { select: { id: true, dropLabel: true, windowStart: true, windowEnd: true } },
    },
  });
  if (!bill) return null;

  const rows = await prisma.checkout.findMany({
    where: {
      profile: { discordUserId: bill.discordUserId },
      occurredAt: { gte: bill.run.windowStart, lte: bill.run.windowEnd },
    },
    orderBy: { occurredAt: "desc" },
    take: PER_BILL_LIMIT,
    select: CHECKOUT_SELECT,
  });

  return {
    ...summarize(bill.run.id, bill.run.dropLabel, bill.run.windowStart, bill.run.windowEnd, rows),
    truncated: rows.length === PER_BILL_LIMIT,
  };
}
