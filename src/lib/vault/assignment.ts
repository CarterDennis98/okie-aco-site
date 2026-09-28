/**
 * Which runner a new profile or login goes to.
 *
 * Every vault account carries an assignee from the moment it is created -- a profile nobody
 * holds is a profile no bot runs, and nobody would notice until a drop. So the choice is
 * made at save time, in this order:
 *
 *   1. THE RUNNER WHO ALREADY HAS THIS MEMBER on the retailer, when all their existing rows
 *      there sit with one runner. A member's profiles on one site travel together: their
 *      fifth Target profile belongs on the same bot as the first four.
 *   2. THE RETAILER'S PAYEE, when it has one -- chess for Crunchyroll and Mattel, peacemaker
 *      for Premium Bandai, CrispHeinz for Topps. Whoever is owed a retailer's fees is the
 *      person running its bot, so a new member there is theirs from the start rather than
 *      waiting on a full admin to hand them over.
 *   3. THE OPERATOR, for everything else. On a retailer shared between runners, a new
 *      member lands with the full admin who decides how to split them.
 *
 * Each candidate must still be a runner there -- `eligible` -- so a runner who has lost the
 * role stops collecting new profiles at once, even while the ones already assigned wait to
 * be moved.
 *
 * Pure, so the rules can be tested without a database. See db/queries/runners.ts for the
 * reads that feed it.
 */
export function pickDefaultAssignee(input: {
  /** Who holds the member's existing rows on this retailer, one entry per row. */
  existing: readonly string[];
  /** Everyone who may hold profiles on this retailer right now. */
  eligible: ReadonlySet<string>;
  /** Who this retailer's fees are owed to, when it isn't the operator. */
  sitePayee: string | null;
  /** The first full admin, or null when none is configured. */
  operator: string | null;
}): string | null {
  const holders = new Set(input.existing);
  if (holders.size === 1) {
    const [only] = holders;
    if (input.eligible.has(only)) return only;
  }
  if (input.sitePayee && input.eligible.has(input.sitePayee)) return input.sitePayee;
  return input.operator;
}
