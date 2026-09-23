import { methodLabel, type PaymentMethod } from "@/lib/billing/methods";
import { siteKey } from "@/lib/sites";

/**
 * Who members pay, when it isn't the operator.
 *
 * Every bill carries a `payeeId`: the Discord id of the person its fees are owed to. The
 * operator is the default and needs no entry -- their bills point at the Discord payment
 * channel (DISCORD_PAYMENT_URL), exactly as every bill did before payees existed. Anyone
 * else a member can owe is listed here, with the handles to pay them at, which is what a
 * charge owed to them shows instead of that channel.
 *
 * Plain data, no "server-only": the charge page and the dashboard both render it, and
 * nothing here is secret -- handles are published to exactly the members who owe money.
 * It lives in code rather than the environment for the same reason: a changed handle is a
 * change to where people send money, and that belongs in the history.
 *
 * Kept in step with PAS_SITE_PAYEES in the bot (okie-aco-mirror/src/config.js), which
 * decides who each checkout's fees are owed to in the first place.
 */

export type PayeeHandle = { method: PaymentMethod; value: string };

export type Payee = {
  id: string;
  /** How members see them named, on the DM and on the charge. */
  name: string;
  /**
   * The retailers whose fees are owed to them -- the same list the bot splits bills by.
   * Read here to tell which of a member's checkouts a given bill actually covers.
   */
  sites: readonly string[];
  /** Where to pay them. Empty means ask them directly -- see payHint. */
  handles: readonly PayeeHandle[];
};

const PAYEES: readonly Payee[] = [
  {
    // Runs Stellar on Crunchyroll, so Crunchyroll fees are his.
    id: "397045810996576266",
    name: "chess",
    sites: ["crunchyroll"],
    handles: [{ method: "venmo", value: "@TJ-Chess" }],
  },
];

const BY_ID = new Map(PAYEES.map((payee) => [payee.id, payee]));

/** Every retailer somebody other than the operator is owed for. */
const CLAIMED_SITES = new Set(PAYEES.flatMap((payee) => payee.sites.map((s) => siteKey(s))));

/**
 * Whether a checkout on `site` is one a bill owed to `payeeId` covers.
 *
 * A listed payee's bills cover their retailers; the operator's cover everything no one else
 * has claimed. Mirrors how the bot splits a run, so a charge's breakdown shows the orders
 * that bill was actually for -- not the member's Target checkouts on Chess's Crunchyroll
 * charge, and not his Crunchyroll ones on the operator's.
 */
export function billCoversSite(payeeId: string, site: string | null): boolean {
  const key = siteKey(site);
  const payee = otherPayee(payeeId);
  if (payee) return payee.sites.some((s) => siteKey(s) === key);
  return !CLAIMED_SITES.has(key);
}

/**
 * The person a charge is owed to, when it isn't the operator; null when it is.
 *
 * Null rather than an operator entry because the operator has never needed one: their
 * charges already have a way to be paid, and a second description of it here would be one
 * more thing to keep in step with the Discord channel.
 */
export function otherPayee(payeeId: string | null | undefined): Payee | null {
  return payeeId ? (BY_ID.get(payeeId) ?? null) : null;
}

/** "Cash App $okie · Venmo @okie" -- one line of how to pay them. */
export function handlesLine(payee: Payee): string {
  return payee.handles.map((h) => `${methodLabel(h.method)} ${h.value}`).join(" · ");
}

/** What to tell a member when a payee has listed no handles yet. */
export function payHint(payee: Payee): string {
  return payee.handles.length > 0
    ? handlesLine(payee)
    : `Message ${payee.name} on Discord for how to pay.`;
}

/**
 * The name to show an admin for who a charge is owed to.
 *
 * "you" for the viewer's own, the listed name for anyone else here, and "Okie ACO" for the
 * operator seen by somebody else -- which today only happens if a site admin were ever shown
 * an operator's charge, and none of the queries do that.
 */
export function payeeLabel(payeeId: string, viewerId: string): string {
  if (payeeId === viewerId) return "you";
  return otherPayee(payeeId)?.name ?? "Okie ACO";
}
