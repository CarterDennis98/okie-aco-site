/**
 * The address book: what counts as the same entry, what an entry must hold, and -- the part that
 * would fail badly -- that a card moved between the book and a profile decrypts only where it
 * now lives. Card numbers are Luhn-valid but not real.
 */
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addressFingerprint,
  addressLine,
  addressTitle,
  cardTitle,
  cleanLabel,
  hasCard,
  MAX_LABEL_LENGTH,
  profilesUsingCard,
  type SavedAddressFields,
} from "@/lib/vault/address-book";
import { moveCard, sealCard } from "@/lib/vault/card-secrets";
import { decrypt, resetKeyringCache } from "@/lib/vault/crypto";
import {
  validateAddressForm,
  validateCardForm,
  validateProfileForm,
} from "@/lib/vault/profile-input";

function formOf(values: Record<string, string>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(values)) if (value !== "") form.set(key, value);
  return form;
}

const ADDRESS: SavedAddressFields = {
  firstName: "Carter",
  lastName: "Dennis",
  phone: "4055551234",
  shipLine1: "10621 NW 40th Ter",
  shipLine2: null,
  shipCity: "Yukon",
  shipState: "OK",
  shipPostalCode: "73099",
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
};

const VISA = { cardBrand: "Visa", cardLast4: "3384", cardExpMonth: "09", cardExpYear: "2029" };

describe("cleanLabel", () => {
  it("tidies a nickname and treats a blank one as none", () => {
    expect(cleanLabel("  Mom's   house ")).toBe("Mom's house");
    expect(cleanLabel("   ")).toBeNull();
    expect(cleanLabel(null)).toBeNull();
    expect(cleanLabel("x".repeat(100))).toHaveLength(MAX_LABEL_LENGTH);
  });
});

describe("titles", () => {
  it("shows the nickname, else the name on it", () => {
    expect(addressTitle({ ...ADDRESS, label: "Home" })).toBe("Home");
    expect(addressTitle({ ...ADDRESS, label: null })).toBe("Carter Dennis");
    expect(addressLine({ ...ADDRESS, shipLine2: "Apt 2" })).toBe(
      "10621 NW 40th Ter, Apt 2, Yukon, OK 73099",
    );
    expect(cardTitle({ ...VISA, label: null })).toBe("Visa ···· 3384");
    expect(cardTitle({ ...VISA, label: "Sapphire" })).toBe("Sapphire · Visa ···· 3384");
  });
});

describe("addressFingerprint", () => {
  it("reads past case, punctuation and ZIP+4", () => {
    expect(
      addressFingerprint({
        ...ADDRESS,
        firstName: "CARTER",
        shipLine1: "10621 N.W. 40th Ter.",
        shipPostalCode: "73099-1234",
      }),
    ).toBe(addressFingerprint(ADDRESS));
  });

  it("ignores the phone, which a randomized one changes on every profile", () => {
    expect(addressFingerprint({ ...ADDRESS, phone: "0" })).toBe(addressFingerprint(ADDRESS));
  });

  it("tells apart another unit, another person, and another billing address", () => {
    const base = addressFingerprint(ADDRESS);
    expect(addressFingerprint({ ...ADDRESS, shipLine2: "Apt 2" })).not.toBe(base);
    expect(addressFingerprint({ ...ADDRESS, firstName: "Jamie" })).not.toBe(base);
    const billed = { ...ADDRESS, sameBillingAndShipping: false, billLine1: "1 Other St" };
    expect(addressFingerprint(billed)).not.toBe(base);
    expect(addressFingerprint({ ...billed, billLine1: "2 Other St" })).not.toBe(
      addressFingerprint(billed),
    );
  });
});

describe("hasCard and profilesUsingCard", () => {
  it("match on brand, last four and expiry -- the plain columns", () => {
    expect(hasCard([VISA], { ...VISA })).toBe(true);
    expect(hasCard([VISA], { ...VISA, cardExpYear: "2030" })).toBe(false);
    expect(hasCard([], VISA)).toBe(false);
  });

  it("counts the profiles already paying with a card, and nothing without one", () => {
    const profiles = [VISA, VISA, { ...VISA, cardLast4: "0001" }, { cardBrand: "", cardLast4: "" }];
    expect(profilesUsingCard(profiles, VISA)).toBe(2);
    expect(profilesUsingCard(profiles, { ...VISA, cardLast4: "" })).toBe(0);
  });
});

describe("validateAddressForm", () => {
  const address = {
    firstName: "Carter",
    lastName: "Dennis",
    shipLine1: "10621 NW 40th Ter",
    shipCity: "Yukon",
    shipState: "OK",
    shipPostalCode: "73099",
    sameBillingAndShipping: "on",
  };

  it("takes an address with no phone and no card", () => {
    expect(validateAddressForm(formOf(address))).toBeNull();
  });

  it("holds an address to a profile's rules", () => {
    expect(validateAddressForm(formOf({ ...address, lastName: "" }))).toMatch(/last name/i);
    expect(validateAddressForm(formOf({ ...address, shipPostalCode: "7309" }))).toMatch(/ZIP/);
    expect(validateAddressForm(formOf({ ...address, shipState: "Okla" }))).toMatch(/two-letter/);
    expect(
      validateAddressForm(formOf({ ...address, sameBillingAndShipping: "", billLine1: "1 St" })),
    ).toMatch(/billing address/i);
  });
});

describe("validateCardForm", () => {
  const card = {
    cardNumber: "4147098930053384",
    cardCvv: "525",
    cardExpMonth: "9",
    cardExpYear: "29",
  };

  it("needs a number and its code to add a card", () => {
    expect(validateCardForm(formOf(card), true)).toBeNull();
    expect(validateCardForm(formOf({ ...card, cardNumber: "" }), true)).toMatch(/card number/i);
    expect(validateCardForm(formOf({ ...card, cardCvv: "" }), true)).toMatch(/security code/i);
    expect(validateCardForm(formOf({ ...card, cardNumber: "4147098930053834" }), true)).toMatch(
      /typo/,
    );
  });

  it("edits the expiry alone, and still checks it", () => {
    const expiryOnly = { cardExpMonth: "11", cardExpYear: "2031" };
    expect(validateCardForm(formOf(expiryOnly), false)).toBeNull();
    expect(validateCardForm(formOf({ ...expiryOnly, cardExpMonth: "13" }), false)).toMatch(/01–12/);
  });
});

describe("validateProfileForm with a saved card", () => {
  const profile = {
    firstName: "Carter",
    lastName: "Dennis",
    shipLine1: "10621 NW 40th Ter",
    shipCity: "Yukon",
    shipState: "OK",
    shipPostalCode: "73099",
    sameBillingAndShipping: "on",
  };

  it("adds a profile with no number typed, and no expiry either -- both are the card's", () => {
    expect(validateProfileForm(formOf(profile), true, "target", { savedCard: true })).toBeNull();
    // Without one, the number is still required.
    expect(validateProfileForm(formOf(profile), true, "target")).toMatch(/card number/i);
  });

  it("keeps every other rule", () => {
    expect(
      validateProfileForm(formOf({ ...profile, phone: "" }), true, "walmart", { savedCard: true }),
    ).toMatch(/phone/i);
    expect(
      validateProfileForm(formOf({ ...profile, shipPostalCode: "1" }), true, "target", {
        savedCard: true,
      }),
    ).toMatch(/ZIP/);
  });
});

describe("moving a card between the book and a profile", () => {
  let saved: NodeJS.ProcessEnv;

  beforeEach(() => {
    saved = { ...process.env };
    for (const name of Object.keys(process.env)) {
      if (name.startsWith("VAULT_KEY")) delete process.env[name];
    }
    process.env.VAULT_KEY_K1 = randomBytes(32).toString("base64");
    process.env.VAULT_KEY_ACTIVE = "k1";
    resetKeyringCache();
  });

  afterEach(() => {
    process.env = saved;
    resetKeyringCache();
  });

  const BOOK_NUMBER = { entity: "saved_card", field: "card_number" };
  const PROFILE_NUMBER = { entity: "vault_profile", field: "card_number" };
  const PROFILE_CVV = { entity: "vault_profile", field: "card_cvv" };

  it("re-seals it for its new column, where it decrypts, and only there", () => {
    const inBook = sealCard("4147098930053384", "052", "saved_card");
    expect(decrypt(inBook.cardNumberEnc, BOOK_NUMBER)).toBe("4147098930053384");
    // Bound to the book's column: a straight copy into a profile would not open.
    expect(() => decrypt(inBook.cardNumberEnc, PROFILE_NUMBER)).toThrow();

    const onProfile = moveCard(inBook, "saved_card", "vault_profile");
    expect(decrypt(onProfile.cardNumberEnc, PROFILE_NUMBER)).toBe("4147098930053384");
    // The leading zero survives the trip.
    expect(decrypt(onProfile.cardCvvEnc, PROFILE_CVV)).toBe("052");
    expect(() => decrypt(onProfile.cardNumberEnc, BOOK_NUMBER)).toThrow();
  });

  it("keeps an absent code absent rather than inventing one", () => {
    const moved = moveCard(
      {
        cardNumberEnc: sealCard("4147098930053384", "", "vault_profile").cardNumberEnc,
        cardCvvEnc: "",
      },
      "vault_profile",
      "saved_card",
    );
    expect(moved.cardCvvEnc).toBe("");
  });
});
