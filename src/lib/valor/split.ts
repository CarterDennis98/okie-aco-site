import { profilesForBot } from "@/lib/vault/bot-split";

/**
 * Which Valor instance runs which Pokémon Center profile.
 *
 * Each member's profiles split main/backup by the one shared rule (bot-split.ts: their first
 * five on the main bot, the rest on a backup), and then the two lists, in name order, split
 * between the instances: the first instance runs the first 250 of each, the second the rest.
 * That is how the operator's two instances were laid out by hand before this export existed
 * -- 2026-11-10: "_alecazam_" to "jirei - 1" and ".jocro - 6" to "dmach711 - 14" on the first,
 * from "jirei - 2" and "dmach711 - 15" on the second -- so a first export moves nothing.
 *
 * A member can straddle the line, their "jirei - 1" on one instance and "jirei - 2" on the
 * other: each profile still runs exactly once.
 *
 * The operator's own profiles are never passed in -- they live in Valor groups of their own,
 * kept by hand (see payload.ts) -- so they count toward neither 250.
 *
 * Pure, shared by the payload and the Export page's counts, so the two can't disagree.
 */

/** The retailers the Valor export writes: Pokémon Center on both instances, Target on the second. */
export const VALOR_PKC_SITE = "pokemon-center";
export const VALOR_TARGET_SITE = "target";

/** How many main-bot profiles, and how many backup-bot profiles, the first instance runs. */
export const FIRST_INSTANCE_CAP = 250;

/** The instances: the first runs Pokémon Center only, the second the rest and Target's line. */
export const VALOR_POSITIONS = [1, 2] as const;
export type ValorPosition = (typeof VALOR_POSITIONS)[number];

/** The instance that runs the Miscellaneous line's Target tasks. */
export const MISC_POSITION: ValorPosition = 2;

export type ValorShare<T> = { main: T[]; backup: T[] };

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export function splitPkc<T extends { name: string; discordUserId: string }>(
  profiles: T[],
  cap: number | undefined,
): Record<ValorPosition, ValorShare<T>> {
  const byMember = new Map<string, T[]>();
  for (const p of profiles)
    byMember.set(p.discordUserId, [...(byMember.get(p.discordUserId) ?? []), p]);
  const side = (bot: "main" | "backup") =>
    [...byMember.values()]
      .flatMap((mine) => profilesForBot(mine, cap, bot))
      .sort((a, b) => collator.compare(a.name, b.name));
  const main = side("main");
  const backup = side("backup");
  return {
    1: { main: main.slice(0, FIRST_INSTANCE_CAP), backup: backup.slice(0, FIRST_INSTANCE_CAP) },
    2: { main: main.slice(FIRST_INSTANCE_CAP), backup: backup.slice(FIRST_INSTANCE_CAP) },
  };
}
