/**
 * The product line on Target Products whose picks run on VALOR, never on Shikari.
 *
 * Its drops come at their own times, so its tasks are started and stopped on their own: since
 * 2026-11-10 they run from the "Target" task group of the operator's second Valor instance
 * (lib/valor), and the Shikari export leaves every product in the line out -- a product on
 * both bots would check a member out twice.
 *
 * Found by NAME, case aside (getSetsInLine), so renaming the line on the site moves its
 * products back onto Shikari and off Valor at the next export of each.
 */
export const MISC_LINE = "Miscellaneous";
