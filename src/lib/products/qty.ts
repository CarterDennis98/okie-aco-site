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

/** Target's limit on one checkout: nothing buys more of a product than this. */
export const MAX_QTY = 2;

/** Every qty a member can pick, lowest first. */
export const QTY_OPTIONS: number[] = Array.from({ length: MAX_QTY }, (_, i) => i + 1);

/** "2 (standard)" for the standard qty, the bare number for any other. */
export function qtyLabel(qty: number): string {
  return qty === STANDARD_QTY ? `${qty} (standard)` : String(qty);
}

const isQty = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1;

/**
 * The qty a checkout actually runs at: `qty` if it's a whole number from 1 up, else
 * `fallback` (else the standard), and never more than MAX_QTY -- whatever was saved before a
 * limit was lowered, or typed into the export. Buying none of a product is no checkout, and
 * Target refuses one past its limit.
 */
export function runnableQty(qty: unknown, fallback: number = STANDARD_QTY): number {
  return Math.min(isQty(qty) ? qty : isQty(fallback) ? fallback : STANDARD_QTY, MAX_QTY);
}
