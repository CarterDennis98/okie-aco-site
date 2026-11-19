import { productLabel } from "@/lib/normalize";
import { siteKey } from "@/lib/sites";
import {
  cancellationReason,
  countsTowardFlag,
  isRaffleEntry,
  matchFailureProfile,
  tidyReason,
} from "@/lib/vault/failure-flags";

/**
 * What each profile has done: its checkouts, and its failures, side by side -- the
 * success/fail view on a member's Profiles page (asked for on 2026-11-15).
 *
 * SINCE ACTIVITY_SINCE ONLY. Failures are recorded from 2026-11-01 (the backfill's start), so
 * that is where the two counts begin together; a profile showing ten successes from September
 * beside the failures of the last two weeks would read as a far better profile than it is.
 *
 * A checkout is matched to its profile the way a failure is (failure-flags.ts): by retailer and
 * by the name its bot printed, keyed by the checkout pipeline's own normalizer. The caller has
 * already narrowed the checkouts to the member's own (through their profile family, as every
 * member query does), so a match can only ever land on one of their own profiles. Failures are
 * already bound to their profile when they arrive.
 *
 * AN ORDER IS ONE LINE. A Target order that checked out and was cancelled days later arrives as
 * a checkout AND a failure with the same order number; it is shown and counted once, as
 * cancelled, not as a success plus a failure.
 *
 * Plain functions, no "server-only": the rows render in the browser.
 */

/** Midnight Central on 2026-11-01: where failure tracking, and so this view, begins. */
export const ACTIVITY_SINCE = new Date("2026-11-01T05:00:00Z");

/** How many events one profile's history shows, newest first. */
export const HISTORY_LIMIT = 100;

export type ProfileActivity = {
  /** Orders that went through and haven't been cancelled. */
  checkedOut: number;
  /** Units across those. */
  units: number;
  /** Orders the retailer cancelled after checkout. */
  cancelled: number;
  /** Declines and checkout errors. */
  failed: number;
  lastAt: Date | null;
};

export type ActivityKind = "checked-out" | "cancelled" | "failed";

export type ActivityEvent = {
  id: string;
  kind: ActivityKind;
  /** When it happened -- for a cancelled order, when it was cancelled. */
  at: Date;
  /** For a cancelled order whose checkout is on file: when it checked out. */
  checkedOutAt: Date | null;
  product: string | null;
  quantity: number | null;
  /** The vendor's words for a failure -- "Payment Declined", "Order Canceled: Item Demand". */
  reason: string | null;
  orderId: string | null;
  /** Whether it counts toward the profile's failure flag. Always false for a checkout. */
  flags: boolean;
};

/** One profile's history, as its panel shows it. */
export type ProfileHistory = {
  /** Newest first, at most HISTORY_LIMIT. */
  events: ActivityEvent[];
  /** How many there are in all, so the panel can say when it shows fewer. */
  total: number;
};

/** A checkout as these functions read it. `product` is its display name, if any. */
export type ActivityCheckout = {
  id: string;
  occurredAt: Date;
  site: string | null;
  profileKey: string | null;
  profileIndex: number | null;
  profileRaw: string | null;
  orderId: string | null;
  quantity: number;
  product: string | null;
};

/** A failure as these functions read it, already bound to its profile. */
export type ActivityFailure = {
  id: string;
  occurredAt: Date;
  siteKey: string | null;
  orderId: string | null;
  reason: string | null;
  productRaw: string | null;
};

type ProfileIdentity = {
  id: string;
  siteKey: string;
  name: string;
  profileKey: string;
  profileIndex: number | null;
};

/**
 * Each checkout's profile, by profile id. A checkout no profile here answers to -- another
 * retailer, a name since renamed away, two of the member's own names that key alike with
 * neither printed exactly -- is left out rather than guessed at.
 */
export function assignCheckouts<C extends ActivityCheckout>(
  checkouts: readonly C[],
  profiles: readonly ProfileIdentity[],
): Map<string, C[]> {
  const assigned = new Map<string, C[]>();
  for (const checkout of checkouts) {
    if (!checkout.profileKey) continue;
    const site = siteKey(checkout.site);
    const candidates = profiles.filter(
      (profile) =>
        profile.siteKey === site &&
        profile.profileKey === checkout.profileKey &&
        profile.profileIndex === checkout.profileIndex,
    );
    const profile = matchFailureProfile(candidates, checkout.profileRaw);
    if (profile) assigned.set(profile.id, [...(assigned.get(profile.id) ?? []), checkout]);
  }
  return assigned;
}

/** "order 123 on target" -- how a checkout and its later cancellation find each other. */
function orderKey(orderId: string | null, site: string | null): string | null {
  const id = orderId?.trim().replace(/^#/, "");
  return id ? `${siteKey(site)}\u0000${id.toLowerCase()}` : null;
}

/**
 * One profile's checkouts and failures as a history, newest first: a cancelled order once,
 * as cancelled, with its checkout's product and quantity. A raffle entry a bot reported as a
 * failure isn't shown at all: it was neither.
 */
export function activityEvents(
  checkouts: readonly ActivityCheckout[],
  failures: readonly ActivityFailure[],
): ActivityEvent[] {
  const byOrder = new Map<string, ActivityCheckout>();
  for (const checkout of checkouts) {
    const key = orderKey(checkout.orderId, checkout.site);
    if (key) byOrder.set(key, checkout);
  }

  const cancelledOrders = new Set<string>();
  const events: ActivityEvent[] = [];

  for (const failure of failures) {
    if (isRaffleEntry(failure.reason)) continue;
    const cancellation = cancellationReason(failure.reason) !== null;
    const key = cancellation ? orderKey(failure.orderId, failure.siteKey) : null;
    const checkout = key ? byOrder.get(key) : undefined;
    if (key && checkout) cancelledOrders.add(key);
    events.push({
      id: failure.id,
      kind: cancellation ? "cancelled" : "failed",
      at: failure.occurredAt,
      checkedOutAt: checkout?.occurredAt ?? null,
      product: checkout?.product ?? (failure.productRaw ? productLabel(failure.productRaw) : null),
      quantity: checkout?.quantity ?? null,
      reason: tidyReason(failure.reason),
      orderId: checkout?.orderId ?? failure.orderId,
      flags: countsTowardFlag(failure.siteKey, failure.reason),
    });
  }

  for (const checkout of checkouts) {
    const key = orderKey(checkout.orderId, checkout.site);
    if (key && cancelledOrders.has(key)) continue;
    events.push({
      id: checkout.id,
      kind: "checked-out",
      at: checkout.occurredAt,
      checkedOutAt: null,
      product: checkout.product,
      quantity: checkout.quantity,
      reason: null,
      orderId: checkout.orderId,
      flags: false,
    });
  }

  return events.sort((a, b) => b.at.getTime() - a.at.getTime());
}

/** The counts on a profile's row, from the same merge its history uses. */
export function summarizeActivity(
  checkouts: readonly ActivityCheckout[],
  failures: readonly ActivityFailure[],
): ProfileActivity | null {
  const events = activityEvents(checkouts, failures);
  if (events.length === 0) return null;
  const summary: ProfileActivity = {
    checkedOut: 0,
    units: 0,
    cancelled: 0,
    failed: 0,
    lastAt: events[0].at,
  };
  for (const event of events) {
    if (event.kind === "checked-out") {
      summary.checkedOut++;
      summary.units += event.quantity ?? 1;
    } else if (event.kind === "cancelled") {
      summary.cancelled++;
    } else {
      summary.failed++;
    }
  }
  return summary;
}
