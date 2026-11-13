import { normalizeProfile, productLabel } from "@/lib/normalize";
import { siteFlaggedCancellations } from "@/lib/sites";

/**
 * Flags on profiles whose checkouts failed.
 *
 * Every failure the mirror posts -- a decline, an order the retailer cancelled, a checkout
 * error -- is matched to the profile it ran on (api/bot/failures), on every retailer. What
 * counts against a profile is the failures since its owner last CHANGED it, less the
 * cancellations its retailer doesn't count (`flaggedCancellations` in sites.ts: on Target, only
 * Item Demand and Reseller do -- a Quantity Limit cancel just means the member hit their limit):
 *
 *   FLAGGED    one or more. Orange: worth a look -- a card, an address, a login.
 *   HIGH RISK  three or more without a change in between. Red: the same details keep failing,
 *              and every drop it runs in like this is a profile slot spent on nothing.
 *
 * Changing the profile -- any saved edit that actually changes something, or an import over it
 * -- clears its failures: the member has acted on them, and what fails after that is news
 * about the new details. Toggling it, reordering it, or saving it unchanged does not.
 *
 * A failure that HAPPENED before the change but only arrives after it (a queue that sat while
 * the site was down) never starts counting, and nor does one from before the profile existed
 * (a name freed by a deletion and taken again): `cleanSince` is the line for both.
 *
 * Plain functions, no "server-only": the profile pages render the levels in the browser, and
 * the ingest route matches with them on the server.
 */

/** Failures that flag a profile. */
export const FLAG_AT = 1;
/** Failures, without a change in between, that make it high risk. */
export const HIGH_RISK_AT = 3;

export type FailureRisk = "flagged" | "high";

export type FailureFlag = {
  /** Failures counting against the profile right now. */
  count: number;
  risk: FailureRisk;
  /** The most recent one's. */
  lastAt: Date;
  lastReason: string | null;
  /** Readable product name, when the vendor named one. */
  lastProduct: string | null;
};

export function riskFor(count: number): FailureRisk | null {
  if (count >= HIGH_RISK_AT) return "high";
  if (count >= FLAG_AT) return "flagged";
  return null;
}

/** One uncleared failure against a profile, as the flag summary reads it. */
export type CountingFailure = {
  vaultProfileId: string;
  /** The retailer it was on, which decides whether a cancellation counts. */
  siteKey: string | null;
  occurredAt: Date;
  reason: string | null;
  productRaw: string | null;
};

/**
 * The policy a retailer gave for cancelling an order after checkout, lowercase -- "item
 * demand", "quantity limit" -- or "" for a cancellation that gave none. Null for a failure that
 * isn't a cancellation at all: a decline, a checkout error.
 *
 * Read the same however the vendor words the rest: Shikari's "Order Canceled: Item Demand",
 * Sniped's "Cancelled Checkout (Policy - Item Demand)", Refract's and Swft's "Policy - Item
 * Demand".
 */
export function cancellationReason(reason: string | null | undefined): string | null {
  const text = tidyReason(reason);
  if (!text) return null;
  const policy = text.match(/\bpolicy\s*[-–—:]\s*([^()]+?)\s*\)?$/i);
  if (policy) return policy[1].trim().toLowerCase();
  const cancelled = text.match(/\bcancel+ed\b\s*(?:checkout|order)?\s*[:\-–—]?\s*(.*)$/i);
  if (cancelled) return cancelled[1].replace(/[()]/g, "").trim().toLowerCase();
  return null;
}

/**
 * Whether this failure counts toward a flag. Every failure does, except a cancellation whose
 * policy its retailer doesn't flag -- see `flaggedCancellations` in sites.ts.
 */
export function countsTowardFlag(siteKey: string | null, reason: string | null): boolean {
  const flagged = siteFlaggedCancellations(siteKey);
  if (!flagged) return true;
  const policy = cancellationReason(reason);
  return policy === null || flagged.includes(policy);
}

/** Profile id -> its flag, for every profile with at least one failure counting. */
export function flagsByProfile(failures: readonly CountingFailure[]): Map<string, FailureFlag> {
  const grouped = new Map<string, CountingFailure[]>();
  for (const failure of failures) {
    if (!countsTowardFlag(failure.siteKey, failure.reason)) continue;
    grouped.set(failure.vaultProfileId, [...(grouped.get(failure.vaultProfileId) ?? []), failure]);
  }

  const flags = new Map<string, FailureFlag>();
  for (const [profileId, list] of grouped) {
    const risk = riskFor(list.length);
    if (!risk) continue;
    const last = list.reduce((a, b) => (b.occurredAt > a.occurredAt ? b : a));
    flags.set(profileId, {
      count: list.length,
      risk,
      lastAt: last.occurredAt,
      lastReason: tidyReason(last.reason),
      lastProduct: last.productRaw ? productLabel(last.productRaw) : null,
    });
  }
  return flags;
}

/** A reason as a sentence fragment: markdown and spoiler bars off, spaces collapsed. */
export function tidyReason(reason: string | null | undefined): string | null {
  const text = String(reason ?? "")
    .replace(/\|\||\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

/** "Failed checkout", "3 failed checkouts" -- the chip. */
export function flagLabel(flag: Pick<FailureFlag, "count">): string {
  return flag.count === 1 ? "Failed checkout" : `${flag.count} failed checkouts`;
}

/**
 * The instant a profile's failures start counting from: its last change, or its creation when
 * it has never been changed. A failure that happened at or before it ran on details that are
 * no longer there -- or on a profile that wasn't this one.
 */
export function cleanSince(profile: { createdAt: Date; failuresClearedAt: Date | null }): Date {
  const cleared = profile.failuresClearedAt;
  return cleared && cleared > profile.createdAt ? cleared : profile.createdAt;
}

/**
 * Which of a retailer's profiles a failure ran on, given the profiles there whose name keys
 * the way the failure's does -- same base, same number, through the checkout pipeline's own
 * normalizer (so "carter - 2" and "Carter-2" are one name, as they are for a checkout).
 *
 * The name the bot printed wins outright when one candidate carries exactly that. Otherwise a
 * single candidate is the one. Two or more with nothing to choose between them is NO MATCH:
 * a flag on the wrong member's profile would be worse than none.
 */
export function matchFailureProfile<T extends { id: string; name: string }>(
  candidates: readonly T[],
  profileRaw: string | null | undefined,
): T | null {
  if (candidates.length === 0) return null;
  const printed = normalizeProfile(profileRaw)?.profileRaw.toLowerCase();
  if (printed) {
    const exact = candidates.filter(
      (candidate) => normalizeProfile(candidate.name)?.profileRaw.toLowerCase() === printed,
    );
    if (exact.length === 1) return exact[0];
  }
  return candidates.length === 1 ? candidates[0] : null;
}
