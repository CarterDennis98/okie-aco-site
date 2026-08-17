import { describe, expect, it } from "vitest";
import { PAYMENT_METHODS, isPaymentMethod, methodLabel } from "@/lib/billing/methods";

describe("payment methods", () => {
  it("accepts every value it offers", () => {
    for (const m of PAYMENT_METHODS) expect(isPaymentMethod(m.value)).toBe(true);
  });

  it("rejects anything else", () => {
    // The guard on the action: a member editing the select cannot store free text.
    for (const bad of ["", "bitcoin", "CashApp", "cashapp ", "reversal", "<script>"]) {
      expect(isPaymentMethod(bad)).toBe(false);
    }
  });

  it("labels known values", () => {
    expect(methodLabel("cashapp")).toBe("Cash App");
    expect(methodLabel("zelle")).toBe("Zelle");
  });

  it("echoes values it does not know rather than dropping them", () => {
    // "reversal" is written by reopenBill and is deliberately not a member-pickable
    // method; a row recorded before this list changed must still render as something.
    expect(methodLabel("reversal")).toBe("reversal");
    expect(methodLabel("some-old-value")).toBe("some-old-value");
  });

  it("says so when no method was recorded", () => {
    expect(methodLabel(null)).toBe("Not stated");
  });
});
