import { z } from "zod";

/**
 * The bot's contract for posting checkouts.
 *
 * `.strict()` throughout: an unrecognised key is an error, not something to ignore. A
 * typo'd field name that silently vanished would be a checkout quietly missing its
 * quantity, and nobody would find out until a bill was wrong.
 *
 * The bot sends RAW values -- `productRaw`, `profileRaw`, the untouched embed. The
 * server derives `productKey`, `profileKey`, and `profileIndex`, so normalization has
 * exactly one implementation and fixing an edge case is a site deploy rather than a
 * coordinated two-repo change mid-drop.
 */

/** Discord snowflakes are 64-bit and exceed 2^53; they are strings everywhere. */
const snowflake = z.string().regex(/^\d{15,25}$/, "not a Discord snowflake");

/**
 * A new vendor lands HERE FIRST, deployed before the bot starts sending it. The bot's
 * outbox refuses to deliver a line the server rejects, so a checkout from a vendor this list
 * doesn't know never reaches the site until it is added here. ingest.test.ts checks this
 * list against the mirror's fixtures. Failures (below) take the same list.
 */
const sourceBot = z.enum([
  "valor",
  "shikari",
  "refract",
  "swft",
  "hidden",
  "stellar",
  "alpine",
  "sniped",
  "makebot",
  "hayha",
]);

export const checkoutInput = z
  .object({
    sourceBot,
    discordMessageId: snowflake,
    discordChannelId: snowflake,
    /** Null for vendors that omit it, and for declines that never got one. */
    orderId: z.string().min(1).max(120).nullable().optional(),
    occurredAt: z.iso.datetime({ offset: true }),
    site: z.string().min(1).max(120).nullable().optional(),
    productRaw: z.string().max(500).nullable().optional(),
    /** Retailer product id when the vendor exposed one. */
    sku: z.string().max(120).nullable().optional(),
    productUrl: z.string().url().max(1000).nullable().optional(),
    imageUrl: z.string().url().max(1000).nullable().optional(),
    profileRaw: z.string().max(200).nullable().optional(),
    /**
     * Zero is ACCEPTED: Alpine has sent "Quantity: 0" on real Topps successes, and refusing
     * one stalled the outbox -- every vendor's checkouts -- for days. The route reads it as
     * no quantity at all, the way /pas run bills it.
     */
    quantity: z.number().int().min(0).max(1000).nullable().optional(),
    quantityAssumed: z.boolean().optional(),
    flags: z.array(z.string().max(60)).max(20).optional(),
    /** Passed through the allowlist server-side; never stored as received. */
    rawEmbed: z.unknown().optional(),
  })
  .strict();

export const checkoutBatch = z
  .object({
    // One drop is ~150 checkouts. The cap is a guard against a runaway loop, not a
    // limit anyone should hit; the bot batches well under it.
    checkouts: z.array(checkoutInput).min(1).max(500),
  })
  .strict();

export type CheckoutInput = z.infer<typeof checkoutInput>;
export type CheckoutBatch = z.infer<typeof checkoutBatch>;

/**
 * The bot's contract for posting FAILED checkouts: declines, cancelled orders, checkout errors
 * (POST /api/bot/failures). They flag the profile they ran on; they are never billed.
 *
 * Raw values, like a checkout's, so the profile is keyed and the retailer read by the same
 * functions the rest of the site uses. NO raw embed: a failure's carries the same logins and
 * proxies a success's does, and the flag needs none of it. Strict for the same reason the
 * checkout contract is.
 */
export const failureInput = z
  .object({
    sourceBot,
    discordMessageId: snowflake,
    discordChannelId: snowflake,
    /** Set on a cancelled order, which was placed first; null on a decline. */
    orderId: z.string().min(1).max(120).nullable().optional(),
    occurredAt: z.iso.datetime({ offset: true }),
    site: z.string().min(1).max(120).nullable().optional(),
    productRaw: z.string().max(500).nullable().optional(),
    profileRaw: z.string().max(200).nullable().optional(),
    /** The vendor's own words -- "Payment Declined", "Policy - Item Demand". */
    reason: z.string().max(300).nullable().optional(),
  })
  .strict();

export const failureBatch = z
  .object({
    failures: z.array(failureInput).min(1).max(500),
  })
  .strict();

export type FailureInput = z.infer<typeof failureInput>;
