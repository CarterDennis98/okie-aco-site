/**
 * Which of a member's profiles run on which bot.
 *
 * A retailer's soft cap (`profileSoftCap` in sites.ts) is how many of a member's profiles
 * the MAIN bot runs; the rest go on a backup. Counted over ACTIVE profiles in name order --
 * the order every page lists them in -- so "the first five" means the same five everywhere.
 *
 * THE ONE IMPLEMENTATION, shared by the AYCD export route and the Shikari export: a profile
 * that one export put on the main bot and the other on the backup would run twice.
 */

export type BotScope = "main" | "backup" | "all";

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/**
 * One member's share for a bot. `profiles` must be that member's ACTIVE profiles on one
 * retailer and one runner -- each runner's bot has its own split.
 *
 * With no cap the main bot runs everything, so a backup gets nothing.
 */
export function profilesForBot<T extends { name: string }>(
  profiles: T[],
  cap: number | undefined,
  bot: BotScope,
): T[] {
  const sorted = [...profiles].sort((a, b) => collator.compare(a.name, b.name));
  if (cap === undefined) return bot === "backup" ? [] : sorted;
  if (bot === "all") return sorted;
  return bot === "main" ? sorted.slice(0, cap) : sorted.slice(cap);
}
