/**
 * Fees issued by hand.
 *
 * The review step and the stored bill are computed by the same functions, so what is pinned
 * here is what a member is actually charged: a line that won't price is refused rather than
 * guessed at, the OG discount follows the bot's rule, and the date lands on the drop night.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_FEE_CENTS,
  MAX_QTY,
  adHocDropLabel,
  adHocInstant,
  parseAdHocLines,
  parseDropDate,
  priceAdHocBill,
  todayInDropZone,
} from "@/lib/billing/ad-hoc";
import { normalizeProduct } from "@/lib/normalize";

const line = (product: string, fee: string, qty: string) => ({ product, fee, qty });

describe("parseAdHocLines", () => {
  it("prices each line and keys it the way the bot keys products", () => {
    const parsed = parseAdHocLines([line("  MG 1/100  Gundam  ", "$8", "2")]);
    expect(parsed).toEqual({
      ok: true,
      lines: [
        {
          label: "MG 1/100 Gundam",
          productKey: normalizeProduct("MG 1/100 Gundam").productKey,
          qty: 2,
          feeCents: 800,
          subtotalCents: 1600,
        },
      ],
    });
  });

  it("drops the blank spare row the form keeps", () => {
    const parsed = parseAdHocLines([line("Figure", "12.50", "1"), line("", "", "")]);
    expect(parsed.ok && parsed.lines).toHaveLength(1);
  });

  it("refuses a line that won't price, and says which", () => {
    const cases: [ReturnType<typeof line>, RegExp][] = [
      [line("", "8", "1"), /Line 1: name the product/],
      [line("Figure", "", "1"), /fee per unit/],
      [line("Figure", "0", "1"), /fee per unit/],
      [line("Figure", "eight", "1"), /fee per unit/],
      [line("Figure", "8", "0"), /whole number/],
      [line("Figure", "8", "1.5"), /whole number/],
      [line("Figure", "8", String(MAX_QTY + 1)), /whole number/],
      [line("Figure", String(MAX_FEE_CENTS / 100 + 1), "1"), /looks like a typo/],
    ];
    for (const [row, message] of cases) {
      const parsed = parseAdHocLines([row]);
      expect(parsed.ok, JSON.stringify(row)).toBe(false);
      if (!parsed.ok) expect(parsed.error).toMatch(message);
    }
  });

  it("refuses the same product twice rather than billing it on two lines", () => {
    const parsed = parseAdHocLines([line("Figure", "8", "1"), line("figure ", "8", "2")]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/Line 2: .*already on this bill/);
  });

  it("refuses a bill with nothing on it", () => {
    expect(parseAdHocLines([line("", "", "")]).ok).toBe(false);
  });
});

describe("priceAdHocBill", () => {
  const lines = [
    { label: "A", productKey: "a", qty: 1, feeCents: 800, subtotalCents: 800 },
    { label: "B", productKey: "b", qty: 3, feeCents: 5, subtotalCents: 15 },
  ];

  it("totals the lines", () => {
    expect(priceAdHocBill(lines, false)).toEqual({
      subtotalCents: 815,
      discountCents: 0,
      totalCents: 815,
    });
  });

  it("takes the OG half off in the member's favour, as the bot does", () => {
    // 815 / 2 = 407.5 -> 408 off, 407 owed.
    expect(priceAdHocBill(lines, true)).toEqual({
      subtotalCents: 815,
      discountCents: 408,
      totalCents: 407,
    });
  });
});

describe("drop dates", () => {
  // 2026-09-28 02:00 UTC is still the evening of 9/27 in Chicago.
  const now = new Date("2026-09-28T02:00:00Z");

  it("names today where the drops are, not where the server is", () => {
    expect(todayInDropZone(now)).toBe("2026-09-27");
  });

  it("accepts a real date on or before today, and within reach", () => {
    expect(parseDropDate("2026-09-27", now)).toBe("2026-09-27");
    expect(parseDropDate(" 2026-09-01 ", now)).toBe("2026-09-01");
  });

  it("refuses the future, the impossible, and the long ago", () => {
    expect(parseDropDate("2026-09-28", now)).toBeNull();
    expect(parseDropDate("2026-02-30", now)).toBeNull();
    expect(parseDropDate("2026-01-01", now)).toBeNull();
    expect(parseDropDate("9/27/2026", now)).toBeNull();
  });

  it("labels a drop the way the bot does, with the retailer in front", () => {
    expect(adHocDropLabel("Premium Bandai", "2026-09-07")).toBe("Premium Bandai · 9/7/2026");
  });

  it("dates the run at noon in Chicago, on either side of daylight saving", () => {
    expect(adHocInstant("2026-09-27").toISOString()).toBe("2026-09-27T17:00:00.000Z"); // CDT
    expect(adHocInstant("2026-12-01").toISOString()).toBe("2026-12-01T18:00:00.000Z"); // CST
  });
});
