import { describe, expect, it } from "vitest";
import { toAycdProfile } from "@/lib/vault/aycd";
import { parseAycdExport } from "@/lib/vault/aycd-import";
import { isValorExport, parseValorExport } from "@/lib/vault/valor-import";

/**
 * Valor's own profile export, read in.
 *
 * The property that matters most is the one at the bottom: a profile carried in Valor's
 * format and in AYCD's imports to the SAME row, because both readers feed the one set of
 * checks. Everything above it is what Valor spells differently -- separate name fields, a
 * one-field expiry, the email at the top -- and what is deliberately never read.
 *
 * Every card here is a published test number; no real profile is in this file.
 */

type ValorProfile = ReturnType<typeof valorProfile>;

function valorProfile(overrides: Record<string, unknown> = {}) {
  const address = {
    firstName: "Mary Ann",
    lastName: "Public",
    addressLine1: "ABC 123 Main St",
    addressLine2: "",
    city: "Norman",
    countryName: "United States",
    countryCode: "US",
    state: "Oklahoma",
    zipCode: "73069",
  };
  return {
    name: "buyer.one_Pokemoncenter",
    email: "Buyer.One@Example.com",
    emailPassword: "",
    phoneNumber: "405-555-0123",
    billingSameAsShipping: true,
    oneCheckout: false,
    quickTask: false,
    card: {
      holder: "Mary Ann Public",
      number: "5555 5555 5555 4444",
      expiration: "02/31",
      cvv: "123",
      type: "mastercard",
    },
    shipping: { ...address },
    billing: { ...address },
    id: "0f8fad5b-d9cb-469f-a165-70867728950e",
    totalSpent: 0,
    ...overrides,
  };
}

/** Valor's own shape: one object, keyed by each profile's id. */
function valorFile(...profiles: ValorProfile[]): string {
  return JSON.stringify(Object.fromEntries(profiles.map((p) => [p.id, p])));
}

function second(overrides: Record<string, unknown> = {}): ValorProfile {
  return valorProfile({
    id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    name: "buyer.two_Pokemoncenter",
    email: "buyer.two@example.com",
    ...overrides,
  });
}

describe("parseValorExport", () => {
  it("reads a file the way Valor writes it", () => {
    const { profiles, issues } = parseValorExport(valorFile(valorProfile(), second()));
    expect(issues).toEqual([]);
    expect(profiles).toHaveLength(2);

    const p = profiles[0];
    expect(p.position).toBe(1);
    expect(p.sourceName).toBe("buyer.one_Pokemoncenter");
    expect(p.email).toBe("buyer.one@example.com");
    // Separate fields in Valor, so nothing is split: a two-word first name survives, where
    // AYCD's single name field would have made "Ann" part of the surname.
    expect(p.firstName).toBe("Mary Ann");
    expect(p.lastName).toBe("Public");
    // The prefix Valor users put on a shared address is part of the address. Kept as is.
    expect(p.shipLine1).toBe("ABC 123 Main St");
    expect(p.shipLine2).toBeNull();
    expect(p.shipCity).toBe("Norman");
    expect(p.shipState).toBe("OK");
    expect(p.shipPostalCode).toBe("73069");
    expect(p.shipCountry).toBe("US");
    expect(p.sameBillingAndShipping).toBe(true);
    expect(p.billLine1).toBeNull();
    expect(p.billState).toBeNull();
    expect(p.cardNumber).toBe("5555555555554444");
    expect(p.cardLast4).toBe("4444");
    expect(p.cardBrand).toBe("MasterCard");
    expect(p.cardExpMonth).toBe("02");
    expect(p.cardExpYear).toBe("2031");
    expect(p.cardCvv).toBe("123");
    expect(p.onlyCheckoutOnce).toBe(false);
    // Valor has no such flag, and every Pokémon Center profile in the vault holds false.
    expect(p.matchNameOnCardAndAddress).toBe(false);

    expect(profiles[1].position).toBe(2);
    expect(profiles[1].email).toBe("buyer.two@example.com");
  });

  it("stores the phone the way the profile form does", () => {
    const phoneOf = (phoneNumber: string) =>
      parseValorExport(valorFile(valorProfile({ phoneNumber }))).profiles[0].phone;

    expect(phoneOf("405-555-0123")).toBe("4055550123");
    expect(phoneOf("+1 (405) 555-0123")).toBe("4055550123");
    // Valor's own "make one up at checkout". Cleaning it away would take the instruction
    // with it -- see BOT_SENTINEL_PHONE.
    expect(phoneOf("0")).toBe("0");
    expect(phoneOf("")).toBeNull();
  });

  it("keeps a separate billing address", () => {
    const { profiles, issues } = parseValorExport(
      valorFile(
        valorProfile({
          billingSameAsShipping: false,
          billing: {
            firstName: "Pat",
            lastName: "Payer",
            addressLine1: "9 Other Ave",
            addressLine2: "Unit 2",
            city: "Tulsa",
            countryName: "United States",
            countryCode: "US",
            state: "OK",
            zipCode: "74103-2201",
          },
        }),
      ),
    );
    expect(issues).toEqual([]);
    const p = profiles[0];
    expect(p.sameBillingAndShipping).toBe(false);
    expect(p.billFirstName).toBe("Pat");
    expect(p.billLastName).toBe("Payer");
    expect(p.billLine1).toBe("9 Other Ave");
    expect(p.billLine2).toBe("Unit 2");
    expect(p.billCity).toBe("Tulsa");
    expect(p.billState).toBe("OK");
    expect(p.billPostalCode).toBe("74103-2201");
    expect(p.billCountry).toBe("US");
  });

  it("reads oneCheckout as check-out-once", () => {
    const { profiles } = parseValorExport(valorFile(valorProfile({ oneCheckout: true })));
    expect(profiles[0].onlyCheckoutOnce).toBe(true);
  });

  it("reads the expiry however it is written, and refuses what it can't read", () => {
    const expiry = (expiration: string) => {
      const card = { ...valorProfile().card, expiration };
      return parseValorExport(valorFile(valorProfile({ card })));
    };

    for (const written of ["02/31", "2/31", "02/2031", "02-31"]) {
      const { profiles } = expiry(written);
      expect([profiles[0]?.cardExpMonth, profiles[0]?.cardExpYear], written).toEqual([
        "02",
        "2031",
      ]);
    }
    // Guessing where a separator was is how 02/31 becomes 20/31. Refused, not guessed.
    for (const written of ["0231", "13/31", "", "02/31/2031"]) {
      const { profiles, issues } = expiry(written);
      expect(profiles, written).toEqual([]);
      expect(issues[0].problem, written).toMatch(/Expiry/);
    }
  });

  it("holds a Valor file to the same checks as an AYCD one", () => {
    const shipping = { ...valorProfile().shipping, zipCode: "1374" };
    const card = { ...valorProfile().card, number: "5555 5555 5555 4445" };
    const { profiles, issues } = parseValorExport(
      valorFile(
        valorProfile({ shipping }),
        second(),
        // The same address twice: one account, one profile.
        second({ id: "e2c5b6a4-1b0f-4f7d-9f52-3a51c1c1f001", name: "again" }),
        second({ id: "e2c5b6a4-1b0f-4f7d-9f52-3a51c1c1f002", email: "luhn@example.com", card }),
      ),
    );

    expect(profiles.map((p) => p.email)).toEqual(["buyer.two@example.com", "luhn@example.com"]);
    expect(issues).toEqual([
      expect.objectContaining({
        position: 1,
        severity: "error",
        problem: expect.stringMatching(/ZIP/),
      }),
      expect.objectContaining({
        position: 3,
        name: "again",
        problem: expect.stringMatching(/more than once/),
      }),
      expect.objectContaining({
        position: 4,
        severity: "warning",
        problem: expect.stringMatching(/Luhn/),
      }),
    ]);
  });

  it("never reads the mailbox password", () => {
    const result = parseValorExport(valorFile(valorProfile({ emailPassword: "mailbox-secret-1" })));
    expect(result.profiles).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("mailbox-secret-1");
  });

  it("never puts a card number, CVV, or email in an issue message", () => {
    const card = { ...valorProfile().card, cvv: "99999" };
    const { issues } = parseValorExport(valorFile(valorProfile({ card })));
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.problem).not.toContain("5555");
      expect(issue.problem).not.toContain("99999");
      expect(issue.problem).not.toContain("example.com");
    }
  });

  it("takes a bare list, or a single profile, as well as the keyed file", () => {
    expect(parseValorExport(JSON.stringify([valorProfile(), second()])).profiles).toHaveLength(2);
    expect(parseValorExport(JSON.stringify(valorProfile())).profiles).toHaveLength(1);
  });

  it("reports a malformed entry by position and keeps going", () => {
    const file = JSON.parse(valorFile(valorProfile(), second()));
    file.broken = { name: "broken" };
    const { profiles, issues } = parseValorExport(JSON.stringify(file));
    expect(profiles).toHaveLength(2);
    expect(issues).toEqual([
      expect.objectContaining({ position: 3, name: "broken", severity: "error" }),
    ]);
  });

  it("caps how many profiles one upload may carry", () => {
    const many = Array.from({ length: 251 }, (_, i) =>
      valorProfile({ id: `id-${i}`, email: `buyer${i}@example.com` }),
    );
    const { profiles, issues } = parseValorExport(valorFile(...many));
    expect(profiles).toEqual([]);
    expect(issues[0].problem).toMatch(/limit is 250/);
  });

  it("rejects a file that isn't JSON, or isn't Valor's", () => {
    expect(parseValorExport("not json at all").issues[0].problem).toMatch(/valid JSON/);
    expect(parseValorExport('{"something":"else"}').issues[0].problem).toMatch(
      /Valor profile export/,
    );
  });

  /**
   * THE ROUND TRIP. One profile, written once as Valor would and once by our own AYCD
   * exporter, must land on the same row -- that is what sharing checkProfiles buys, and
   * what a second copy of the rules would quietly lose.
   */
  it("imports the same profile to the same row whichever bot wrote the file", () => {
    const valor = parseValorExport(
      valorFile(
        valorProfile({
          name: "buyer - 1",
          phoneNumber: "4055550123",
          billingSameAsShipping: false,
          shipping: { ...valorProfile().shipping, firstName: "Mary", addressLine2: "Apt 5" },
          billing: {
            ...valorProfile().billing,
            firstName: "Pat",
            lastName: "Payer",
            addressLine1: "9 Other Ave",
            city: "Tulsa",
            state: "Oklahoma",
            zipCode: "74103",
          },
        }),
      ),
    );
    const aycd = parseAycdExport(
      JSON.stringify([
        toAycdProfile({
          id: "cm0a1b2c3d4e5f6g7h8i9j0k",
          siteKey: "pokemon-center",
          name: "buyer - 1",
          email: "buyer.one@example.com",
          firstName: "Mary",
          lastName: "Public",
          phone: "4055550123",
          shipLine1: "ABC 123 Main St",
          shipLine2: "Apt 5",
          shipCity: "Norman",
          shipState: "OK",
          shipPostalCode: "73069",
          shipCountry: "US",
          sameBillingAndShipping: false,
          billFirstName: "Pat",
          billLastName: "Payer",
          billLine1: "9 Other Ave",
          billLine2: null,
          billCity: "Tulsa",
          billState: "OK",
          billPostalCode: "74103",
          billCountry: "US",
          onlyCheckoutOnce: false,
          matchNameOnCardAndAddress: false,
          cardBrand: "MasterCard",
          cardExpMonth: "02",
          cardExpYear: "2031",
          cardNumber: "5555555555554444",
          cardCvv: "123",
        }),
      ]),
    );

    expect(valor.issues).toEqual([]);
    expect(aycd.issues).toEqual([]);
    expect(valor.profiles).toEqual(aycd.profiles);
  });
});

describe("isValorExport", () => {
  it("knows Valor's file in each shape it is taken in", () => {
    expect(isValorExport(valorFile(valorProfile(), second()))).toBe(true);
    expect(isValorExport(JSON.stringify([valorProfile()]))).toBe(true);
    expect(isValorExport(JSON.stringify(valorProfile()))).toBe(true);
  });

  it("leaves AYCD's file, and anything else, to the AYCD reader", () => {
    const aycd = toAycdProfile({
      id: "cm0a1b2c3d4e5f6g7h8i9j0k",
      siteKey: "pokemon-center",
      name: "buyer - 1",
      email: "buyer.one@example.com",
      firstName: "Mary",
      lastName: "Public",
      phone: null,
      shipLine1: "123 Main St",
      shipLine2: null,
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
      onlyCheckoutOnce: false,
      matchNameOnCardAndAddress: false,
      cardBrand: "MasterCard",
      cardExpMonth: "02",
      cardExpYear: "2031",
      cardNumber: "5555555555554444",
      cardCvv: "123",
    });
    expect(isValorExport(JSON.stringify([aycd]))).toBe(false);
    expect(isValorExport(JSON.stringify({ profiles: [aycd] }))).toBe(false);
    // A file mixing the two is neither; the AYCD reader reports the rows it can't read.
    expect(isValorExport(JSON.stringify([aycd, valorProfile()]))).toBe(false);

    for (const text of ["not json", "null", "[]", "{}", '{"something":"else"}', "42"]) {
      expect(isValorExport(text), text).toBe(false);
    }
  });
});
