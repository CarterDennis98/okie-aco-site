import { z } from "zod";
import type { BotScope } from "@/lib/vault/bot-split";

/**
 * One Shikari instance's setup, as the operator leaves it between drops: whose profiles it
 * runs, which of the main/backup split, which parts of its backup an export rewrites, and
 * what becomes of the other Target groups in it.
 *
 * Stored as JSON (ShikariInstance.config), so it is validated BOTH ways: on the way in,
 * because a Server Action takes whatever is POSTed, and on the way out, because a column
 * holding last month's shape must still load -- field by field, so one setting that no
 * longer fits doesn't cost the operator the member list beside it.
 */

const snowflake = z.string().regex(/^\d{15,25}$/);

export const BOT_SCOPES = ["main", "backup", "all"] as const satisfies readonly BotScope[];

const sectionFields = {
  profiles: z.boolean(),
  accounts: z.boolean(),
  imap: z.boolean(),
  proxies: z.boolean(),
  tasks: z.boolean(),
  misc: z.boolean(),
  wipes: z.boolean(),
  raffles: z.boolean(),
};

const sections = z.object(sectionFields).strict();

/**
 * Sections as stored. "raffles" and "misc" came on 2026-11-19, so a setup saved before then has
 * neither: it gets them as a fresh one does -- raffles ON, and misc OFF, since the Miscellaneous
 * line runs on Valor unless the operator says otherwise -- rather than losing every other
 * section's choice to the defaults.
 */
const storedSections = z.object({
  ...sectionFields,
  misc: z.boolean().default(false),
  raffles: z.boolean().default(true),
});

/**
 * Keep or clear, for another Target profile group -- keyed by its name as `groupKey` has it
 * ("targetsecondary"), since a name is what stays the same from one backup to the next.
 * Only the operator's own choices are stored; a group with none gets defaultGroupChoice.
 */
const groupChoices = z
  .record(z.string().regex(/^[a-z0-9]{1,60}$/), z.enum(["keep", "remove"]))
  .refine((choices) => Object.keys(choices).length <= 50, "Too many groups.");

export const shikariInstanceConfig = z
  .object({
    memberIds: z.array(snowflake).max(500),
    /** Which of each member's profiles: the main bot's first five, the rest, or all. */
    bot: z.enum(BOT_SCOPES),
    sections,
    groups: groupChoices,
  })
  .strict();

export type ShikariInstanceConfig = z.infer<typeof shikariInstanceConfig>;
export type GroupChoice = "keep" | "remove";

/**
 * A fresh instance: everyone's main-bot profiles, every section but the Miscellaneous line
 * (which runs on Valor until the operator says otherwise), every group by its default.
 */
export function defaultInstanceConfig(memberIds: string[] = []): ShikariInstanceConfig {
  return {
    memberIds,
    bot: "main",
    sections: {
      profiles: true,
      accounts: true,
      imap: true,
      proxies: true,
      tasks: true,
      misc: false,
      wipes: true,
      raffles: true,
    },
    groups: {},
  };
}

/**
 * A stored config, read leniently: a field that is missing or no longer the right shape
 * falls back to its default on its own, and a field that is no longer used is dropped.
 */
const storedConfig = z.object({
  memberIds: z.array(snowflake).max(500).catch([]),
  bot: z.enum(BOT_SCOPES).catch("main"),
  sections: storedSections.catch(defaultInstanceConfig().sections),
  groups: groupChoices.catch({}),
});

export function readInstanceConfig(raw: unknown): ShikariInstanceConfig {
  const parsed = storedConfig.safeParse(raw);
  return parsed.success ? parsed.data : defaultInstanceConfig();
}

/**
 * Whether an instance runs the Miscellaneous line: its misc box, which is part of the tasks
 * section and means nothing with that off.
 */
export function runsMiscLine(config: Pick<ShikariInstanceConfig, "sections">): boolean {
  return config.sections.tasks && config.sections.misc;
}

/** Whether two bot scopes can hand the same profile to two instances. */
export function scopesOverlap(a: BotScope, b: BotScope): boolean {
  return a === "all" || b === "all" || a === b;
}

/** Instances one export can carry. More than anyone runs, and a bound on the request. */
export const MAX_INSTANCES = 12;

export const exportRequest = z
  .object({
    instances: z
      .array(
        z
          .object({
            position: z.number().int().min(1).max(MAX_INSTANCES),
            config: shikariInstanceConfig,
          })
          .strict(),
      )
      .min(1)
      .max(MAX_INSTANCES),
  })
  .strict();

export type ExportRequest = z.infer<typeof exportRequest>;
