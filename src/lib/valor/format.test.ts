import { describe, expect, it } from "vitest";
import {
  ValorFormatError,
  newValorProfile,
  parseValorBackup,
  serializeValorBackup,
  updateValorProfile,
  valorCardNumber,
  valorCardType,
  valorExpiry,
  valorPhone,
  type ProfileSource,
} from "@/lib/valor/format";
import { valorBackup } from "../../../tests/valor/fixture";

const source = (over: Partial<ProfileSource> = {}): ProfileSource => ({
  name: "alice - 1",
  email: "alice1@example.com",
  phone: "4055550101",
  shipping: {
    firstName: "Alice",
    lastName: "Tester",
    street: "1 Main St",
    street2: "",
    city: "Oklahoma City",
    state: "OK",
    zip: "73170",
    country: "US",
  },
  billing: null,
  card: { number: "4111111111111111", expMonth: "09", expYear: "2031", cvv: "123" },
  onlyCheckoutOnce: false,
  ...over,
});

describe("Valor's formats", () => {
  it("writes a phone the way Valor shows one, and keeps its 0", () => {
    expect(valorPhone("4055550101")).toBe("405-555-0101");
    expect(valorPhone("+1 (405) 555-0101")).toBe("405-555-0101");
    expect(valorPhone("0")).toBe("0");
    expect(valorPhone("12345")).toBe("12345");
  });

  it("spaces a card number as printed", () => {
    expect(valorCardNumber("4111111111111111")).toBe("4111 1111 1111 1111");
    expect(valorCardNumber("378282246310005")).toBe("3782 822463 10005");
    expect(valorCardNumber("4111 1111 1111")).toBe("411111111111");
  });

  it("names the card brand as Valor does, and a store card not at all", () => {
    expect(valorCardType("4111111111111111")).toBe("visa");
    expect(valorCardType("5555555555554444")).toBe("mastercard");
    expect(valorCardType("2221000000000009")).toBe("mastercard");
    expect(valorCardType("378282246310005")).toBe("amex");
    expect(valorCardType("6011000990139424")).toBe("discover");
    expect(valorCardType("3530111333300000")).toBe("jcb");
    // Target's REDcard, and anything unknown.
    expect(valorCardType("6394630000000000")).toBe("");
    expect(valorCardType("9999999999999999")).toBe("");
  });

  it("writes the expiry as MM/YY", () => {
    expect(valorExpiry("9", "2031")).toBe("09/31");
    expect(valorExpiry("12", "29")).toBe("12/29");
  });

  it("builds a profile in Valor's key order, billing written out in full", () => {
    const p = newValorProfile(source(), "id-1");
    expect(Object.keys(p)).toEqual([
      "name",
      "email",
      "phoneNumber",
      "billingSameAsShipping",
      "oneCheckout",
      "quickTask",
      "card",
      "shipping",
      "billing",
      "id",
      "totalSpent",
    ]);
    expect(Object.keys(p.card)).toEqual(["holder", "number", "expiration", "cvv", "type"]);
    expect(Object.keys(p.shipping)).toEqual([
      "firstName",
      "lastName",
      "addressLine1",
      "addressLine2",
      "city",
      "countryName",
      "countryCode",
      "state",
      "zipCode",
    ]);
    expect(p.shipping).toMatchObject({
      state: "Oklahoma",
      countryName: "United States",
      countryCode: "US",
    });
    expect(p.billing).toEqual(p.shipping);
    expect(p.billingSameAsShipping).toBe(true);
  });

  it("puts the billing name on the card", () => {
    const p = newValorProfile(
      source({ billing: { ...source().shipping, firstName: "Bea", street: "9 Bill Rd" } }),
      "id-1",
    );
    expect(p.card.holder).toBe("Bea Tester");
    expect(p.billingSameAsShipping).toBe(false);
    expect(p.billing.addressLine1).toBe("9 Bill Rd");
  });

  it("changes nothing in a profile that matches, and keeps a card name that is still right", () => {
    const p = newValorProfile(source(), "id-1");
    p.card.holder = "Alice Tester";
    p.quickTask = true;
    p.totalSpent = 42;
    const before = JSON.stringify(p);
    expect(updateValorProfile(p, source())).toEqual([]);
    expect(JSON.stringify(p)).toBe(before);
    // Punctuation Valor adds isn't a change.
    p.phoneNumber = "(405) 555-0101";
    expect(updateValorProfile(p, source())).toEqual([]);
  });

  it("says what changed, in place, keeping Valor's own fields", () => {
    const p = newValorProfile(source(), "id-1");
    p.quickTask = true;
    p.totalSpent = 42;
    const fields = updateValorProfile(
      p,
      source({
        card: { number: "5555555555554444", expMonth: "01", expYear: "2030", cvv: "456" },
        onlyCheckoutOnce: true,
      }),
    );
    expect(fields).toEqual(["one checkout", "card", "card expiry", "CVV", "card type"]);
    expect(p).toMatchObject({ id: "id-1", quickTask: true, totalSpent: 42, oneCheckout: true });
    expect(p.card).toEqual({
      holder: "Alice Tester",
      number: "5555 5555 5555 4444",
      expiration: "01/30",
      cvv: "456",
      type: "mastercard",
    });
  });

  it("reads a backup back exactly as it was written", () => {
    const text = serializeValorBackup(valorBackup());
    expect(serializeValorBackup(parseValorBackup(text))).toBe(text);
  });

  it("refuses a file that isn't a Valor backup", () => {
    expect(() => parseValorBackup("not json")).toThrow(ValorFormatError);
    expect(() => parseValorBackup(JSON.stringify({ version: "3.0" }))).toThrow(
      "no tasks groups and lists",
    );
    const broken = valorBackup();
    (broken.profiles.lists["g-aco-main"]["p-alice-1"] as { id: string }).id = "other";
    expect(() => parseValorBackup(JSON.stringify(broken))).toThrow(
      "profile p-alice-1 is malformed",
    );
  });
});
