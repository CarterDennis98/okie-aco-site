/**
 * Card helper tests.
 *
 * The brand and expiry cases use the exact shapes present in the real Target export --
 * 26 Amex (15 digits, 4-digit CVV), 6 profiles whose stored cardType is blank, and 18
 * CVVs with a leading zero. Test numbers below are Luhn-valid but not real cards.
 */
import { describe, expect, it } from "vitest";
import {
  cardSignature,
  detectBrand,
  expectedCvvLength,
  isExpired,
  isLuhnValid,
  isValidCvv,
  last4,
  maskedLabel,
  normalizeExpiry,
  normalizePan,
  toAycdCardType,
} from "@/lib/vault/card";

describe("detectBrand", () => {
  it("identifies the four brands in the export", () => {
    expect(detectBrand("4147098930053384")).toBe("Visa");
    expect(detectBrand("5122308498520161")).toBe("MasterCard");
    expect(detectBrand("372658867781002")).toBe("AmericanExpress");
    expect(detectBrand("6011009319673781")).toBe("Discover");
  });

  it("covers the 2221-2720 Mastercard range", () => {
    expect(detectBrand("2221000000000009")).toBe("MasterCard");
    expect(detectBrand("2720999999999996")).toBe("MasterCard");
    // Just outside the range, so it must not be claimed.
    expect(detectBrand("2220000000000000")).not.toBe("MasterCard");
  });

  it("names Target REDcards instead of leaving them Unknown", () => {
    // Six real profiles use BIN 6394. AYCD stores a blank cardType for all of them,
    // so this is display-only -- the export must still emit "".
    expect(detectBrand("6394634050065421")).toBe("TargetRedCard");
    expect(toAycdCardType(detectBrand("6394634050065421"))).toBe("");
  });

  it("does not let a REDcard be mistaken for Discover", () => {
    expect(detectBrand("6011009319673781")).toBe("Discover");
    expect(toAycdCardType("Discover")).toBe("Discover");
  });

  it("returns Unknown rather than guessing", () => {
    expect(detectBrand("9999999999999999")).toBe("Unknown");
    expect(detectBrand("")).toBe("Unknown");
    expect(toAycdCardType("Unknown")).toBe("");
  });

  it("ignores spaces and dashes the way a paste from a bank site contains them", () => {
    expect(detectBrand("4147 0989 3005 3384")).toBe("Visa");
    expect(detectBrand("3726-5886-7781-002")).toBe("AmericanExpress");
  });
});

describe("normalizePan / last4", () => {
  it("keeps digits only", () => {
    expect(normalizePan("4147 0989-3005 3384")).toBe("4147098930053384");
    expect(last4("4147 0989 3005 3384")).toBe("3384");
  });
});

describe("isLuhnValid", () => {
  it("accepts valid numbers", () => {
    for (const pan of ["4147098930053384", "5122308498520161", "372658867781002"]) {
      expect(isLuhnValid(pan), pan).toBe(true);
    }
  });

  it("rejects a transposition, which is the typo it exists to catch", () => {
    expect(isLuhnValid("4147098930053384")).toBe(true);
    expect(isLuhnValid("4147098930053834")).toBe(false); // last two digits swapped
  });

  it("rejects lengths that are not card-shaped", () => {
    expect(isLuhnValid("41470989")).toBe(false);
    expect(isLuhnValid("")).toBe(false);
  });
});

describe("expectedCvvLength", () => {
  it("is 4 for Amex and 3 for the mainstream networks", () => {
    expect(expectedCvvLength("AmericanExpress")).toBe(4);
    expect(expectedCvvLength("Visa")).toBe(3);
    expect(expectedCvvLength("MasterCard")).toBe(3);
    expect(expectedCvvLength("Discover")).toBe(3);
  });

  it("hints 3 for a REDcard but accepts either length", () => {
    // The export holds four distinct REDcards: three with a 3-digit code, one with 4.
    // Enforcing either number would reject a card that actually works.
    expect(expectedCvvLength("TargetRedCard")).toBe(3);
    expect(isValidCvv("818", "TargetRedCard")).toBe(true);
    expect(isValidCvv("0818", "TargetRedCard")).toBe(true);
  });
});

describe("isValidCvv", () => {
  it("holds the mainstream networks to exactly 3", () => {
    expect(isValidCvv("123", "Visa")).toBe(true);
    expect(isValidCvv("1234", "Visa")).toBe(false);
    expect(isValidCvv("12", "MasterCard")).toBe(false);
  });

  it("holds Amex to exactly 4", () => {
    expect(isValidCvv("1234", "AmericanExpress")).toBe(true);
    expect(isValidCvv("123", "AmericanExpress")).toBe(false);
  });

  it("rejects anything that isn't digits", () => {
    expect(isValidCvv("12a", "Visa")).toBe(false);
    expect(isValidCvv("", "Visa")).toBe(false);
    expect(isValidCvv(" 123", "Visa")).toBe(false);
  });

  it("keeps a leading zero meaningful", () => {
    // "037" is a real stored code. Treating it as the number 37 fails checkout.
    expect(isValidCvv("037", "Visa")).toBe(true);
  });
});

describe("normalizeExpiry", () => {
  it("pads the month, because a lost leading zero breaks checkout", () => {
    expect(normalizeExpiry("9", "2029")).toEqual({ month: "09", year: "2029" });
    expect(normalizeExpiry("09", "2029")).toEqual({ month: "09", year: "2029" });
  });

  it("expands a two-digit year", () => {
    expect(normalizeExpiry("11", "30")).toEqual({ month: "11", year: "2030" });
  });

  it("survives a round trip through the Shikari export, which strips the zero", () => {
    // Shikari writes cc_exp_month=9; AYCD writes "09". Both must land the same.
    expect(normalizeExpiry("9", "2029")).toEqual(normalizeExpiry("09", "2029"));
  });
});

describe("isExpired", () => {
  const now = new Date("2026-08-14T00:00:00Z");

  it("treats a card as valid through the last day of its expiry month", () => {
    expect(isExpired("08", "2026", now)).toBe(false);
    expect(isExpired("07", "2026", now)).toBe(true);
  });

  it("handles year boundaries", () => {
    expect(isExpired("01", "2027", now)).toBe(false);
    expect(isExpired("12", "2025", now)).toBe(true);
  });
});

describe("maskedLabel", () => {
  it("renders what the UI shows instead of a number", () => {
    expect(maskedLabel("Visa", "3384")).toBe("Visa ···· 3384");
  });
});

describe("cardSignature", () => {
  const card = { cardBrand: "Visa", cardLast4: "4242", cardExpMonth: "09", cardExpYear: "2030" };

  it("matches the same card entered twice", () => {
    expect(cardSignature(card)).toBe(cardSignature({ ...card }));
  });

  it("separates cards differing in any one part", () => {
    expect(cardSignature(card)).not.toBe(cardSignature({ ...card, cardLast4: "1111" }));
    expect(cardSignature(card)).not.toBe(cardSignature({ ...card, cardExpMonth: "10" }));
    expect(cardSignature(card)).not.toBe(cardSignature({ ...card, cardExpYear: "2031" }));
    expect(cardSignature(card)).not.toBe(cardSignature({ ...card, cardBrand: "Mastercard" }));
  });

  it("ignores brand casing, which the importers and the form spell differently", () => {
    expect(cardSignature({ ...card, cardBrand: "VISA" })).toBe(cardSignature(card));
  });

  it("is null when there is no card, so profiles without one never group together", () => {
    expect(cardSignature({ ...card, cardLast4: "" })).toBeNull();
  });
});
