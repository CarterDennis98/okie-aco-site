import { z } from "zod";

/**
 * Who holds each runner role, posted by the bot.
 *
 * A SNAPSHOT per role, never a delta: every role named here arrives with its complete list
 * of holders, and anyone not on it no longer has it. That is what makes the endpoint safe to
 * call again and again -- on startup, on every role change, and on a timer -- and what lets
 * one missed event heal itself on the next post.
 *
 * `.strict()` like the other bot contracts: an unrecognised key is an error rather than
 * something to ignore.
 */

const snowflake = z.string().regex(/^\d{15,25}$/, "not a Discord snowflake");

export const runnerHolderInput = z
  .object({
    id: snowflake,
    /** Their Discord username, so someone who has never signed in still has a name. */
    username: z.string().min(1).max(100),
    globalName: z.string().max(100).nullable().optional(),
  })
  .strict();

export const runnerRolesInput = z
  .object({
    /** Role id -> everyone holding it right now. */
    roles: z.record(snowflake, z.array(runnerHolderInput).max(1000)),
  })
  .strict();

export type RunnerRolesInput = z.infer<typeof runnerRolesInput>;
