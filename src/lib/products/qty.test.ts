/**
 * What a checkout runs at where nobody picked, and when a pick is past a product's limit.
 *
 * The properties with something behind them: a product limited below the standard defaults
 * to its limit, so an untouched member is never run past it; a limit above the standard
 * changes nothing; and a pick is only ever warned about, never lowered.
 */
import { describe, expect, it } from "vitest";
import { MAX_QTY, STANDARD_QTY, defaultQtyFor, overLimit, runnableQty } from "@/lib/products/qty";

describe("defaultQtyFor", () => {
  it("is the standard on a product with no limit posted", () => {
    expect(STANDARD_QTY).toBe(2);
    expect(defaultQtyFor(null)).toBe(STANDARD_QTY);
    expect(defaultQtyFor(undefined)).toBe(STANDARD_QTY);
  });

  it("is the limit where that's below the standard, and the standard otherwise", () => {
    expect(defaultQtyFor(1)).toBe(1);
    expect(defaultQtyFor(2)).toBe(2);
    expect(defaultQtyFor(5)).toBe(STANDARD_QTY);
  });

  it("works against the export's own standard too", () => {
    expect(defaultQtyFor(2, 4)).toBe(2);
    expect(defaultQtyFor(null, 4)).toBe(4);
    expect(defaultQtyFor(3, 1)).toBe(1);
    // A standard typed past the most is the most, as runnableQty has it; nonsense is the site's.
    expect(defaultQtyFor(null, 50)).toBe(MAX_QTY);
    expect(defaultQtyFor(1, 0)).toBe(1);
    expect(defaultQtyFor(null, 0)).toBe(STANDARD_QTY);
  });

  it("ignores a limit that isn't one", () => {
    expect(defaultQtyFor(0)).toBe(STANDARD_QTY);
    expect(defaultQtyFor(1.5)).toBe(STANDARD_QTY);
  });

  it("is only a default: a member's own pick on a limited product runs as picked", () => {
    expect(runnableQty(null, defaultQtyFor(1))).toBe(1);
    expect(runnableQty(2, defaultQtyFor(1))).toBe(2);
    expect(runnableQty(4, defaultQtyFor(1))).toBe(4);
  });
});

describe("overLimit", () => {
  it("is past a posted limit, and never where none is posted", () => {
    expect(overLimit(2, 1)).toBe(true);
    expect(overLimit(1, 1)).toBe(false);
    expect(overLimit(MAX_QTY, null)).toBe(false);
    expect(overLimit(MAX_QTY, undefined)).toBe(false);
    // "Mixed" -- profiles at different qtys -- is no qty to judge.
    expect(overLimit(null, 1)).toBe(false);
  });
});
