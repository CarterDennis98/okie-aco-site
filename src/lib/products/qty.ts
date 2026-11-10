/**
 * How many of a product Shikari buys for a profile in one checkout: its qty.
 *
 * A member picks one per product, and can pick a different one for each profile (see
 * ProductSelection.qty and ProductSelectionQty). STANDARD_QTY is what runs where they
 * haven't: what every checkout ran at before there was a choice, and what the Shikari
 * export's own setting starts at, so "standard" means the same number on the page and in the
 * backup. Plain constants, with no server code: the products page, its action and the
 * export page all read them.
 *
 * Target posts its own limit on some products -- 1 on one, 2 on another -- and an admin
 * copies it onto the product (DropProduct.maxQty). A limit is shown and warned about, never
 * enforced on a pick; what it does change is the default, see defaultQtyFor.
 */

export const STANDARD_QTY = 2;

/** The most a member can pick, and the most any checkout buys of a product. */
export const MAX_QTY = 10;

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

/**
 * The qty a product runs at for a member who picked none for it: `standard`, or the
 * product's posted limit where that is lower.
 *
 * The standard is the page's STANDARD_QTY, or the export's own setting where one is typed
 * there (TaskSettings.checkoutQty). Without this, a product Target limits to 1 would run
 * every member who never opened its qty at 2 -- over the limit, on every profile, with no
 * one having chosen it. A limit above the standard changes nothing: nobody is run for more
 * than they asked for because a product allows it.
 *
 * Only ever a DEFAULT. A qty a member picks is kept as picked, past the limit included (see
 * overLimit), so the page stores a pick as null exactly when it equals this.
 */
export function defaultQtyFor(
  maxQty: number | null | undefined,
  standard: number = STANDARD_QTY,
): number {
  const base = runnableQty(standard);
  return isQty(maxQty) && maxQty < base ? maxQty : base;
}

/**
 * Whether `qty` is past the limit Target posts for the product, which the page warns about.
 * False where no limit is posted: with none, there is nothing to warn against.
 */
export function overLimit(qty: number | null, maxQty: number | null | undefined): boolean {
  return qty !== null && isQty(maxQty) && qty > maxQty;
}
