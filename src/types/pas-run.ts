import { z } from "zod";

/**
 * The billing run the bot posts after `/pas run` finishes sending.
 *
 * Mirrors the session record the bot already writes to data/pas-sessions/*.json, minus
 * everything the site has no business storing: the raw scan, the fee draft, and the
 * per-profile working state are all bot-side scratch.
 *
 * `.strict()` like the checkout contract -- an unrecognised key is an error rather than
 * something to ignore, because a silently dropped field here is money rendered wrong.
 */

const snowflake = z.string().regex(/^\d{15,25}$/, "not a Discord snowflake");

/** One product on one member's bill. Amounts are a SNAPSHOT, never recomputed. */
export const billLineInput = z
  .object({
    productKey: z.string().min(1).max(400),
    label: z.string().min(1).max(400),
    qty: z.number().int().min(1).max(10_000),
    feeCents: z.number().int().min(0).max(1_000_000),
    subtotalCents: z.number().int().min(0).max(10_000_000),
  })
  .strict();

export const billInput = z
  .object({
    userId: snowflake,
    subtotalCents: z.number().int().min(0).max(10_000_000),
    discountCents: z.number().int().min(0).max(10_000_000),
    totalCents: z.number().int().min(0).max(10_000_000),
    isOg: z.boolean(),
    /** The exact DM text the member received. What settles a dispute months later. */
    message: z.string().max(8000).nullable().optional(),
    lines: z.array(billLineInput).max(200),
    /** Set when the operator excluded this member from the run. */
    skip: z.boolean().optional(),
    skipReason: z.string().max(200).nullable().optional(),
  })
  .strict();

export const deliveryResultInput = z
  .object({
    userId: snowflake,
    status: z.string().min(1).max(40),
    messageId: snowflake.nullable().optional(),
    error: z.string().max(500).nullable().optional(),
    at: z.number().int().nullable().optional(),
  })
  .strict();

export const pasRunInput = z
  .object({
    /** The bot's session id. The idempotency key -- re-posting is always safe. */
    sessionId: z.string().min(1).max(80),
    operatorId: snowflake,
    dryRun: z.boolean(),
    windowStartMs: z.number().int(),
    windowEndMs: z.number().int(),
    dropLabel: z.string().min(1).max(80),
    sentAtMs: z.number().int().nullable().optional(),
    bills: z.array(billInput).max(500),
    delivery: z.array(deliveryResultInput).max(500),
  })
  .strict();

export type PasRunInput = z.infer<typeof pasRunInput>;
export type BillInput = z.infer<typeof billInput>;
