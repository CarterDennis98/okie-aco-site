import { describe, expect, it } from "vitest";
import {
  parseAccountList,
  parseAycdExport,
  planImport,
  type ExistingAccount,
  type ParsedProfile,
} from "@/lib/vault/aycd-import";
import { toAycdProfile } from "@/lib/vault/aycd";

/**
 * The round trip is the property that matters: whatever the admin export writes, the
 * member import must read back to the same values. These build a profile, run it through
 * `toAycdProfile`, and parse the result.
 */

const profile = {
  name: "carter - 3",
  email: "buyer@example.com",
  firstName: "Jane",
  lastName: "Q Public",
  phone: "4055550123",
  shipLine1: "123 Main St",
  shipLine2: "Apt 5",
  shipCity: "Norman",
  shipState: "OK",
  shipPostalCode: "73069",
  shipCountry: "US",
  sameBillingAndShipping: true,
  billFirstName: null as string | null,
  billLastName: null as string | null,
  billLine1: null as string | null,
  billLine2: null as string | null,
  billCity: null as string | null,
  billState: null as string | null,
  billPostalCode: null as string | null,
  billCountry: null as string | null,
  onlyCheckoutOnce: false,
  matchNameOnCardAndAddress: true,
  cardBrand: "Visa",
  cardExpMonth: "07",
  cardExpYear: "2030",
  cardNumber: "4111111111111111",
  cardCvv: "123",
};

function exported(overrides: Partial<typeof profile> = {}) {
  return JSON.stringify([toAycdProfile({ ...profile, ...overrides })]);
}

describe("parseAycdExport", () => {
  it("round-trips what the exporter writes", () => {
    const { profiles, issues } = parseAycdExport(exported());
    expect(issues).toEqual([]);
    expect(profiles).toHaveLength(1);

    const p = profiles[0];
    expect(p.email).toBe("buyer@example.com");
    expect(p.firstName).toBe("Jane");
    // Multi-word surnames survive: split on the FIRST space only.
    expect(p.lastName).toBe("Q Public");
    expect(p.shipLine2).toBe("Apt 5");
    expect(p.shipState).toBe("OK");
    expect(p.sameBillingAndShipping).toBe(true);
    expect(p.matchNameOnCardAndAddress).toBe(true);
    expect(p.cardNumber).toBe("4111111111111111");
    expect(p.cardLast4).toBe("1111");
    expect(p.cardExpMonth).toBe("07");
    expect(p.cardExpYear).toBe("2030");
    // The export writes "Oklahoma" / "United States"; storage holds codes, and every
    // one of the 269 existing rows holds a code. A round trip must not fork that.
    expect(p.shipCountry).toBe("US");
  });

  it("turns the export's spelled-out state and country back into codes", () => {
    const raw = JSON.parse(exported());
    expect(raw[0].shippingAddress.state).toBe("Oklahoma");
    expect(raw[0].shippingAddress.country).toBe("United States");

    const { profiles } = parseAycdExport(JSON.stringify(raw));
    expect(profiles[0].shipState).toBe("OK");
    expect(profiles[0].shipCountry).toBe("US");
  });

  it("leaves an already-coded state alone", () => {
    const raw = JSON.parse(exported());
    raw[0].shippingAddress.state = "OK";
    const { profiles } = parseAycdExport(JSON.stringify(raw));
    expect(profiles[0].shipState).toBe("OK");
  });

  it("keeps a separate billing address", () => {
    const { profiles } = parseAycdExport(
      exported({
        sameBillingAndShipping: false,
        billFirstName: "Jane",
        billLastName: "Q Public",
        billLine1: "9 Other Ave",
        billLine2: "Unit 2",
        billCity: "Tulsa",
        billState: "OK",
        billPostalCode: "74103",
        billCountry: "US",
      }),
    );
    expect(profiles[0].billLine1).toBe("9 Other Ave");
    expect(profiles[0].billLine2).toBe("Unit 2");
    expect(profiles[0].billCity).toBe("Tulsa");
  });

  it("rejects a file that isn't JSON", () => {
    const { profiles, issues } = parseAycdExport("not json at all");
    expect(profiles).toEqual([]);
    expect(issues[0].problem).toMatch(/valid JSON/);
  });

  it("rejects JSON that isn't a profile list", () => {
    const { issues } = parseAycdExport('{"something":"else"}');
    expect(issues[0].problem).toMatch(/AYCD profile export/);
  });

  it("accepts a { profiles: [...] } wrapper", () => {
    const { profiles } = parseAycdExport(`{"profiles":${exported()}}`);
    expect(profiles).toHaveLength(1);
  });

  it("skips a row with no email and keeps going", () => {
    const good = JSON.parse(exported())[0];
    const bad = JSON.parse(exported())[0];
    bad.name = "broken";
    bad.shippingAddress = { ...bad.shippingAddress, email: "" };
    bad.billingAddress = { ...bad.billingAddress, email: "" };

    const { profiles, issues } = parseAycdExport(JSON.stringify([bad, good]));
    expect(profiles).toHaveLength(1);
    expect(issues).toHaveLength(1);
    expect(issues[0].name).toBe("broken");
    expect(issues[0].severity).toBe("error");
  });

  it("refuses the same email twice — one address, one profile", () => {
    const one = JSON.parse(exported())[0];
    const { profiles, issues } = parseAycdExport(JSON.stringify([one, one]));
    expect(profiles).toHaveLength(1);
    expect(issues[0].problem).toMatch(/more than once/);
  });

  it("warns rather than rejects on a card that fails Luhn", () => {
    const { profiles, issues } = parseAycdExport(exported({ cardNumber: "4111111111111112" }));
    expect(profiles).toHaveLength(1);
    expect(issues.some((i) => i.severity === "warning" && /Luhn/.test(i.problem))).toBe(true);
  });

  it("never puts a card number, CVV, or email in an issue message", () => {
    const { issues } = parseAycdExport(
      JSON.stringify([
        {
          name: "leaky",
          shippingAddress: { name: "Jane Public", email: "buyer@example.com" },
          billingAddress: {},
          paymentDetails: { cardNumber: "4111111111111111", cardCvv: "999" },
          sameBillingAndShippingAddress: true,
        },
      ]),
    );
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.problem).not.toContain("4111");
      expect(issue.problem).not.toContain("999");
      expect(issue.problem).not.toContain("buyer@example.com");
    }
  });

  it("caps how many profiles one upload may carry", () => {
    const one = JSON.parse(exported())[0];
    const many = Array.from({ length: 251 }, () => one);
    const { profiles, issues } = parseAycdExport(JSON.stringify(many));
    expect(profiles).toEqual([]);
    expect(issues[0].problem).toMatch(/limit is 250/);
  });
});

describe("parseAccountList", () => {
  it("reads the shape the accounts export writes", () => {
    const map = parseAccountList("a@example.com:hunter2\nb@example.com:pw\n");
    expect(map.get("a@example.com")).toBe("hunter2");
    expect(map.size).toBe(2);
  });

  it("splits on the first colon only, so passwords may contain colons", () => {
    const map = parseAccountList("a@example.com:pa:ss:word");
    expect(map.get("a@example.com")).toBe("pa:ss:word");
  });

  it("lowercases the address so it matches the profile's", () => {
    const map = parseAccountList("MixedCase@Example.com:pw");
    expect(map.get("mixedcase@example.com")).toBe("pw");
  });

  it("ignores blanks, comments, and malformed lines", () => {
    const map = parseAccountList("\n# a comment\nnot-an-email\nnocolon@example.com\n");
    expect(map.size).toBe(0);
  });
});

describe("planImport", () => {
  function parsedFor(email: string, position = 1): ParsedProfile {
    const { profiles } = parseAycdExport(exported({ email }));
    return { ...profiles[0], position };
  }

  const plan = (over: Partial<Parameters<typeof planImport>[0]> = {}) =>
    planImport({
      profiles: [parsedFor("new@example.com")],
      accounts: [],
      takenNames: [],
      myNames: [],
      passwords: new Map([["new@example.com", "pw"]]),
      viewerDiscordId: "111",
      viewerUsername: "shockereyes",
      ...over,
    });

  it("assigns the member's own name, never the one in the file", () => {
    const result = plan();
    expect(result.creates).toHaveLength(1);
    // The file said "carter - 3"; this member is shockereyes with no profiles yet.
    expect(result.creates[0].name).toBe("shockereyes");
    expect(result.creates[0].parsed.sourceName).toBe("carter - 3");
  });

  it("continues the member's existing sequence, filling gaps", () => {
    // They hold 1 and 3, so the next free slot is 2 -- not 4.
    const result = plan({
      myNames: ["shockereyes", "shockereyes - 3"],
      takenNames: ["shockereyes", "shockereyes - 3"],
    });
    expect(result.creates[0].name).toBe("shockereyes - 2");
  });

  it("skips a name another member already holds on that site", () => {
    const result = plan({
      myNames: ["shockereyes"],
      takenNames: ["shockereyes", "shockereyes - 2"],
    });
    expect(result.creates[0].name).toBe("shockereyes - 3");
  });

  it("names several new profiles in one file without colliding", () => {
    const result = plan({
      profiles: [parsedFor("a@example.com", 1), parsedFor("b@example.com", 2)],
      passwords: new Map([
        ["a@example.com", "pw"],
        ["b@example.com", "pw"],
      ]),
    });
    expect(result.creates.map((c) => c.name)).toEqual(["shockereyes", "shockereyes - 2"]);
  });

  it("updates in place when the address is already theirs", () => {
    const accounts: ExistingAccount[] = [
      { id: "acc1", email: "new@example.com", discordUserId: "111", profileId: "prof1" },
    ];
    const result = plan({ accounts });
    expect(result.creates).toHaveLength(0);
    expect(result.updates).toEqual([
      { parsed: expect.anything(), profileId: "prof1", accountId: "acc1", password: "pw" },
    ]);
  });

  it("refuses an address registered to somebody else", () => {
    const accounts: ExistingAccount[] = [
      { id: "acc1", email: "new@example.com", discordUserId: "999", profileId: "prof1" },
    ];
    const result = plan({ accounts });
    expect(result.creates).toHaveLength(0);
    expect(result.updates).toHaveLength(0);
    expect(result.issues[0].problem).toMatch(/another member/);
  });

  it("will not invent an account without a login", () => {
    const result = plan({ passwords: new Map() });
    expect(result.creates).toHaveLength(0);
    expect(result.needPassword).toEqual(["new@example.com"]);
  });

  it("reuses an account that exists without a profile, no login needed", () => {
    const accounts: ExistingAccount[] = [
      { id: "acc1", email: "new@example.com", discordUserId: "111", profileId: null },
    ];
    const result = plan({ accounts, passwords: new Map() });
    expect(result.needPassword).toEqual([]);
    expect(result.creates[0].accountId).toBe("acc1");
    expect(result.creates[0].password).toBeNull();
  });
});
