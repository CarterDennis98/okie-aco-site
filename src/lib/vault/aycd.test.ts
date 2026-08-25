import { describe, expect, it } from "vitest";
import { toAycdProfile, type ExportableProfile } from "@/lib/vault/aycd";
import { BOT_SENTINEL_PHONE } from "@/lib/vault/profile-input";

/**
 * What the export is allowed to put in the phone field.
 *
 * THE REGRESSION THIS GUARDS. Valor's importer rejects an entire profile file -- "invalid
 * profile list", naming no row -- if any one profile has an empty phone. A Pokémon Center
 * export of two profiles failed to import because ONE of them had no phone on file.
 *
 * The other half of the rule matters just as much: everything else that was suspected
 * first is legitimate and must keep passing through untouched. Valor's own store holds 173
 * profiles with punctuated phones and 2 with a ZIP+4, so normalizing those would be
 * mangling good data to fix a problem they never caused.
 */

const base: ExportableProfile = {
  name: "carter - 3",
  email: "buyer@example.com",
  firstName: "Jane",
  lastName: "Public",
  phone: "4055550123",
  shipLine1: "123 Main St",
  shipLine2: "Apt 5",
  shipCity: "Norman",
  shipState: "OK",
  shipPostalCode: "73069",
  shipCountry: "US",
  sameBillingAndShipping: true,
  billFirstName: null,
  billLastName: null,
  billLine1: null,
  billLine2: null,
  billCity: null,
  billState: null,
  billPostalCode: null,
  billCountry: null,
  cardBrand: "Visa",
  cardExpMonth: "07",
  cardExpYear: "2030",
  onlyCheckoutOnce: false,
  matchNameOnCardAndAddress: true,
  cardNumber: "4111111111111111",
  cardCvv: "123",
};

const phoneOf = (over: Partial<ExportableProfile>) =>
  toAycdProfile({ ...base, ...over }).shippingAddress.phone;

describe("toAycdProfile phone", () => {
  it("never writes an empty phone, whatever the column holds", () => {
    // All three are "we have no number for this member" as stored by the different
    // write paths -- the form nulls a blank field, an AYCD import can leave "".
    expect(phoneOf({ phone: null })).toBe(BOT_SENTINEL_PHONE);
    expect(phoneOf({ phone: "" })).toBe(BOT_SENTINEL_PHONE);
    expect(phoneOf({ phone: "   " })).toBe(BOT_SENTINEL_PHONE);
  });

  it("writes the same value into both addresses", () => {
    // Billing is its own object when it differs from shipping, and a blank phone there
    // fails the import exactly as readily.
    const out = toAycdProfile({
      ...base,
      phone: null,
      sameBillingAndShipping: false,
      billLine1: "9 Other St",
      billCity: "Tulsa",
      billState: "OK",
      billPostalCode: "74103",
      billCountry: "US",
    });
    expect(out.billingAddress.phone).toBe(BOT_SENTINEL_PHONE);
    expect(out.shippingAddress.phone).toBe(BOT_SENTINEL_PHONE);
  });

  it("leaves a real number alone, punctuation included", () => {
    expect(phoneOf({})).toBe("4055550123");
    // Valor accepts these -- 173 of its live profiles carry one. Not ours to rewrite.
    expect(phoneOf({ phone: "330-607-9000" })).toBe("330-607-9000");
  });

  it("passes the sentinel through rather than treating it as missing", () => {
    expect(phoneOf({ phone: BOT_SENTINEL_PHONE })).toBe(BOT_SENTINEL_PHONE);
  });
});

describe("toAycdProfile postcode", () => {
  it("exports a ZIP+4 unchanged", () => {
    // Proven importable: the failing file kept its ZIP+4 and went in once the phone was
    // fixed. Truncating to five digits would throw away real address precision.
    const out = toAycdProfile({ ...base, shipPostalCode: "15001-2908" });
    expect(out.shippingAddress.postCode).toBe("15001-2908");
  });
});
