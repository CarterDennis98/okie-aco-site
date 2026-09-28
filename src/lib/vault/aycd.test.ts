import { describe, expect, it } from "vitest";
import { toAccountList, toAycdProfile, type ExportableProfile } from "@/lib/vault/aycd";
import { BOT_SENTINEL_PHONE, normalizePhone } from "@/lib/vault/profile-input";

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
 *
 * And the fix for Valor is Valor's alone. Its "0" sentinel went out to every retailer, so
 * a Target profile saved without a phone reached a bot that doesn't read the convention
 * with "0" as its number. Off Valor a missing phone has to become a real-looking one.
 */

const base: ExportableProfile = {
  id: "cm0a1b2c3d4e5f6g7h8i9j0k",
  // A Valor retailer, so the sentinel cases below read as they always have.
  siteKey: "pokemon-center",
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

describe("toAycdProfile phone on a Valor retailer", () => {
  it("never writes an empty phone, whatever the column holds", () => {
    // All three are "we have no number for this member" as stored by the different
    // write paths -- the form nulls a blank field, an AYCD import can leave "".
    expect(phoneOf({ phone: null })).toBe(BOT_SENTINEL_PHONE);
    expect(phoneOf({ phone: "" })).toBe(BOT_SENTINEL_PHONE);
    expect(phoneOf({ phone: "   " })).toBe(BOT_SENTINEL_PHONE);
  });

  it("hands Valor its sentinel on every retailer it runs", () => {
    for (const siteKey of ["pokemon-center", "best-buy"]) {
      expect(phoneOf({ siteKey, phone: null }), siteKey).toBe(BOT_SENTINEL_PHONE);
    }
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

describe("toAycdProfile phone on any other bot", () => {
  const offValor = (over: Partial<ExportableProfile>) =>
    phoneOf({ siteKey: "target", phone: null, ...over });

  it("writes a real number instead of Valor's sentinel", () => {
    for (const siteKey of ["target", "crunchyroll", "premium-bandai"]) {
      for (const phone of [null, "", "   "]) {
        const out = offValor({ siteKey, phone });
        // Ten digits `normalizePhone` would store unchanged -- the same bar the die meets.
        expect(normalizePhone(out), `${siteKey} with ${JSON.stringify(phone)}`).toBe(out);
      }
    }
  });

  it("treats a stored sentinel as missing, since nothing here will read it", () => {
    const out = offValor({ phone: BOT_SENTINEL_PHONE });
    expect(out).not.toBe(BOT_SENTINEL_PHONE);
    expect(normalizePhone(out)).toBe(out);
  });

  it("defaults to a real number on a retailer it doesn't know", () => {
    // The direction that works on any bot, Valor included. See botGeneratesPhone.
    const out = offValor({ siteKey: "some-new-store" });
    expect(normalizePhone(out)).toBe(out);
  });

  it("takes the area code from the shipping state, as the form's die does", () => {
    expect(["405", "580", "918"]).toContain(offValor({ shipState: "OK" }).slice(0, 3));
    expect(["303", "719", "970"]).toContain(offValor({ shipState: "CO" }).slice(0, 3));
  });

  it("holds still: the same profile exports the same number every time", () => {
    expect(offValor({})).toBe(offValor({}));
    // ...while another profile gets its own, rather than the whole file sharing one.
    expect(offValor({ id: "cm9z8y7x6w5v4u3t2s1r0q9p" })).not.toBe(offValor({}));
  });

  it("writes the same number into both addresses", () => {
    const out = toAycdProfile({
      ...base,
      siteKey: "crunchyroll",
      phone: null,
      sameBillingAndShipping: false,
      billLine1: "9 Other St",
      billCity: "Tulsa",
      billState: "OK",
      billPostalCode: "74103",
      billCountry: "US",
    });
    expect(normalizePhone(out.shippingAddress.phone)).toBe(out.shippingAddress.phone);
    expect(out.billingAddress.phone).toBe(out.shippingAddress.phone);
  });

  it("leaves a number the member typed alone, punctuation included", () => {
    expect(offValor({ phone: "4055550123" })).toBe("4055550123");
    expect(offValor({ phone: "330-607-9000" })).toBe("330-607-9000");
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

/**
 * The account list, which the bots read for retailer logins.
 *
 * The two-field shape is a CONTRACT with anything that splits on ":" and takes `parts[1]`
 * as the password. A Costco login also carries the security code its checkout prompts for,
 * so those lines gain a third field -- and nothing else may.
 */
describe("toAccountList", () => {
  it("writes email:password, one per line", () => {
    const out = toAccountList([
      { email: "a@example.com", password: "hunter2" },
      { email: "b@example.com", password: "correct horse" },
    ]);
    expect(out).toBe("a@example.com:hunter2\nb@example.com:correct horse");
  });

  it("appends the security code as a third field when there is one", () => {
    const out = toAccountList([{ email: "a@example.com", password: "hunter2", cvv: "123" }]);
    expect(out).toBe("a@example.com:hunter2:123");
  });

  /**
   * The trailing-separator case, and the reason `cvv` is checked for truthiness rather
   * than for being present: "email:password:" reads as a code that failed to decrypt, and
   * an operator would go looking for a key problem that doesn't exist.
   */
  it("omits the separator entirely when no code is stored", () => {
    for (const cvv of [null, undefined, ""]) {
      const out = toAccountList([{ email: "a@example.com", password: "hunter2", cvv }]);
      expect(out, `cvv ${JSON.stringify(cvv)} should not add a separator`).toBe(
        "a@example.com:hunter2",
      );
    }
  });

  it("mixes both shapes in one file, since a login may predate the code", () => {
    const out = toAccountList([
      { email: "a@example.com", password: "p1", cvv: "4321" },
      { email: "b@example.com", password: "p2", cvv: null },
    ]);
    expect(out.split("\n")).toEqual(["a@example.com:p1:4321", "b@example.com:p2"]);
  });

  it("is empty rather than a stray newline when nothing qualifies", () => {
    expect(toAccountList([])).toBe("");
  });
});
