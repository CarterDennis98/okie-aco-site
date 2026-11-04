/**
 * How many of a product Shikari buys for a profile in one checkout: its qty.
 *
 * A member picks one per product, and can pick a different one for each profile (see
 * ProductSelection.qty and ProductSelectionQty). STANDARD_QTY is what runs where they
 * haven't: what every checkout ran at before there was a choice, and what the Shikari
 * export's own setting starts at, so "standard" means the same number on the page and in the
 * backup. Plain constants, with no server code: the products page, its action and the
 * export page all read them.
 */

export const STANDARD_QTY = 2;

/** The most a member can pick, and the most any checkout buys of a product. */
export const MAX_QTY = 10;

/**
 * What Target usually lets one checkout buy of a product. A member may pick more, up to
 * MAX_QTY -- the page warns that more than this may cause problems at checkout.
 */
export const TARGET_LIMIT = 2;

/** Every qty a member can pick, lowest first. */
export const QTY_OPTIONS: number[] = Array.from({ length: MAX_QTY }, (_, i) => i + 1);

const isQty = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1;

/**
 * The qty a checkout actually runs at: `qty` if it's a whole number from 1 up, else
 * `fallback` (else the standard), and never more than MAX_QTY -- whatever was saved, or typed
 * into the export. Buying none of a product is no checkout.
 */
export function runnableQty(qty: unknown, fallback: number = STANDARD_QTY): number {
  return Math.min(isQty(qty) ? qty : isQty(fallback) ? fallback : STANDARD_QTY, MAX_QTY);
}
