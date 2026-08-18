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

/**
 * Read a typed dollar amount as cents. Null when it isn't a usable number.
 *
 * Accepts what people actually type into a money field -- "12", "12.5", "$12.50", "1,250"
 * -- and rejects everything else rather than guessing. Rounds at the end because
 * `12.34 * 100` is 1233.9999999999998 in binary floating point, and a cent lost to that
 * would put a bill a cent short of settled forever.
 */
export function parseCents(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  if (!/^\d*\.?\d{0,2}$/.test(cleaned)) return null;
  const dollars = Number(cleaned);
  if (!Number.isFinite(dollars) || dollars < 0) return null;
  return Math.round(dollars * 100);
}
