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

/** The most a member can pick. Target caps most drops at a few per order. */
export const MAX_QTY = 5;

/** Every qty a member can pick, lowest first. */
export const QTY_OPTIONS: number[] = Array.from({ length: MAX_QTY }, (_, i) => i + 1);

/** "2 (standard)" for the standard qty, the bare number for any other. */
export function qtyLabel(qty: number): string {
  return qty === STANDARD_QTY ? `${qty} (standard)` : String(qty);
}
