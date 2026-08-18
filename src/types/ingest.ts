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

export const checkoutInput = z
  .object({
    sourceBot: z.enum(["valor", "shikari", "refract", "swft", "hidden"]),
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
    quantity: z.number().int().min(1).max(1000).nullable().optional(),
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
