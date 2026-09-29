import { describe, expect, it } from "vitest";
import {
  MAX_CREDIT_CENTS,
  balanceAfter,
  cleanCreditNote,
  parseCreditAmount,
  parseCreditMode,
} from "@/lib/billing/aco-credit";

describe("parseCreditAmount", () => {
  it("reads what people type into a money field", () => {
    expect(parseCreditAmount("10")).toEqual({ ok: true, cents: 1000 });
    expect(parseCreditAmount("$12.50")).toEqual({ ok: true, cents: 1250 });
    expect(parseCreditAmount(" 1,000 ")).toEqual({ ok: true, cents: 100000 });
    // The float that would otherwise lose a cent: 12.34 * 100 is 1233.99...
    expect(parseCreditAmount("12.34")).toEqual({ ok: true, cents: 1234 });
  });

  it("refuses nothing, zero, and anything that isn't an amount", () => {
    for (const raw of ["", "0", "$0.00", "ten", "-5", "1.234"]) {
      expect(parseCreditAmount(raw).ok, raw).toBe(false);
    }
  });

  it("refuses an amount past the ceiling as a likely typo", () => {
    expect(parseCreditAmount(String(MAX_CREDIT_CENTS / 100)).ok).toBe(true);
    const over = parseCreditAmount("1000.01");
    expect(over.ok).toBe(false);
    expect(!over.ok && over.error).toMatch(/typo/);
  });
});

describe("parseCreditMode", () => {
  it("accepts give and take, and nothing else", () => {
    expect(parseCreditMode("give")).toBe("give");
    expect(parseCreditMode("take")).toBe("take");
    expect(parseCreditMode("GIVE")).toBeNull();
    expect(parseCreditMode(null)).toBeNull();
  });
});

describe("cleanCreditNote", () => {
  it("trims and flattens what was typed, and caps its length", () => {
    expect(cleanCreditNote("  Referral\n bonus  ")).toBe("Referral bonus");
    expect(cleanCreditNote("x".repeat(500))).toHaveLength(120);
  });

  it("is null when nothing was typed", () => {
    expect(cleanCreditNote("")).toBeNull();
    expect(cleanCreditNote("   \n ")).toBeNull();
  });
});

describe("balanceAfter", () => {
  it("adds what is given", () => {
    expect(balanceAfter(0, "give", 1000)).toEqual({ ok: true, cents: 1000 });
    expect(balanceAfter(250, "give", 1000)).toEqual({ ok: true, cents: 1250 });
  });

  it("takes back up to what is left, and no further", () => {
    expect(balanceAfter(1000, "take", 400)).toEqual({ ok: true, cents: 600 });
    expect(balanceAfter(1000, "take", 1000)).toEqual({ ok: true, cents: 0 });

    // Spent credit is gone; taking it again would leave them owing money they never had.
    const over = balanceAfter(300, "take", 400);
    expect(over.ok).toBe(false);
    expect(!over.ok && over.error).toMatch(/only have \$3/);
    expect(balanceAfter(0, "take", 100).ok).toBe(false);
  });
});
