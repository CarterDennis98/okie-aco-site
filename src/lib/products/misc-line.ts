/**
 * The product line on Target Products whose picks run apart from everything else: its drops
 * come at their own times, so its tasks are started and stopped on their own.
 *
 * VALOR builds it into the "Target" groups of the operator's second Valor instance
 * (lib/valor), since 2026-11-10 -- and since 2026-11-24 only with that export's "Target tasks"
 * box on; off, Valor's Target is left exactly as it is. SHIKARI builds it only on an instance
 * set to run it (the export's "Miscellaneous tasks" box, since 2026-11-19), from a task group
 * of its own, "Target - Miscellaneous"; every other instance leaves its products out and
 * empties that group. Where both bots have it, only one may be started for a drop -- a
 * product started on both checks a member out twice -- and the Shikari review says so.
 *
 * Found by NAME, case aside (getSetsInLine), so renaming the line on the site puts its
 * products back with the rest at the next export of each bot.
 */
export const MISC_LINE = "Miscellaneous";
