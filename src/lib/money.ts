/**
 * Money formatting and the OG discount rule.
 *
 * Source of truth: okie-aco-mirror/src/pas/render.js (`money`) and
 * okie-aco-mirror/src/pas/fees.js (`computeBills`).
 *
 * The site DISPLAYS bills; it never recomputes them. A member seeing a different
 * total on the website than in their DM is the worst failure mode this system has,
 * so the arithmetic below exists only for previewing what a *future* run would
 * charge — never for re-deriving an existing PasBill. Sent bills read their amounts
 * straight from the snapshot columns.
 *
 * All amounts are integer cents. Never a float, never Decimal.
 */

/** Fees are usually whole dollars, so "$8" rather than "$8.00". */
export function money(cents: number): string {
  const abs = Math.abs(cents);
  const sign = cents < 0 ? "-" : "";
  return abs % 100 === 0 ? `${sign}$${abs / 100}` : `${sign}$${(abs / 100).toFixed(2)}`;
}

/**
 * OG members get 50% off, rounded in the member's favour (half up on the discount).
 * Matches `Math.round(subtotalCents / 2)` in the bot's computeBills.
 */
export function ogDiscountCents(subtotalCents: number, isOg: boolean): number {
  return isOg ? Math.round(subtotalCents / 2) : 0;
}

export function totalAfterDiscount(subtotalCents: number, isOg: boolean): number {
  return subtotalCents - ogDiscountCents(subtotalCents, isOg);
}

/**
 * Item names are wrapped in backticks in the DM; a backtick or newline in a vendor
 * product name would break the code span and garble the message.
 */
export function safeLabel(label: string): string {
  return String(label)
    .replace(/`/g, "'")
    .replace(/[\r\n]+/g, " ")
    .trim();
}
